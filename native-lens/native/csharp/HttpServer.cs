using System;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;

namespace Slice;

/// <summary>Minimal HTTP/1.1 server on raw sockets: keep-alive, Content-Length and chunked request bodies, loopback only.</summary>
sealed class HttpServer
{
    static readonly byte[] NotFoundBody = "{\"error\":\"rota desconhecida\"}"u8.ToArray();
    static readonly byte[] UnauthorizedBody = "{\"error\":\"token ausente ou invalido\"}"u8.ToArray();
    static readonly byte[] InvalidJsonBody = "{\"error\":\"JSON invalido\"}"u8.ToArray();
    static readonly byte[] EmptyBody = "{}"u8.ToArray();

    readonly Socket _listener;
    readonly byte[] _tokenDigest;

    HttpServer(Socket listener, string token)
    {
        _listener = listener;
        _tokenDigest = SHA256.HashData(Encoding.UTF8.GetBytes(token));
    }

    /// <summary>Binds 127.0.0.1:<paramref name="port"/>; throws a SocketException if the port is taken.</summary>
    public static HttpServer Listen(int port, string token)
    {
        var socket = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
        socket.Bind(new IPEndPoint(IPAddress.Loopback, port));
        socket.Listen(512);
        return new HttpServer(socket, token);
    }

    /// <summary>Accepts connections until the process is killed; each connection runs on its own task.</summary>
    public async Task RunAsync()
    {
        while (true)
        {
            Socket client;
            try
            {
                client = await _listener.AcceptAsync();
            }
            catch (SocketException e)
            {
                Console.Error.WriteLine("accept failed: " + e.Message);
                await Task.Delay(50);
                continue;
            }
            client.NoDelay = true;
            _ = Task.Run(() => ServeAsync(client));
        }
    }

    async Task ServeAsync(Socket client)
    {
        using var stream = new NetworkStream(client, ownsSocket: true);
        try
        {
            var conn = new Connection(stream);
            while (await ServeOneAsync(conn, stream))
            {
            }
        }
        catch (Exception e) when (e is IOException or SocketException or ObjectDisposedException)
        {
            // the peer went away mid-request; nothing to answer
        }
        catch (Exception e)
        {
            Console.Error.WriteLine("connection failed: " + e);
        }
    }

    async Task<bool> ServeOneAsync(Connection conn, NetworkStream stream)
    {
        string? head;
        try
        {
            head = await conn.ReadHeadAsync();
        }
        catch (InvalidDataException e)
        {
            await WriteAsync(stream, 400, Encoding.UTF8.GetBytes("{\"error\":\"" + e.Message + "\"}"), false);
            return false;
        }
        if (head is null)
        {
            return false;
        }
        var request = RequestHead.Parse(head);
        if (request is null)
        {
            await WriteAsync(stream, 400, "{\"error\":\"bad request\"}"u8.ToArray(), false);
            return false;
        }
        if (request.Expect100)
        {
            await stream.WriteAsync("HTTP/1.1 100 Continue\r\n\r\n"u8.ToArray());
        }
        byte[] body;
        try
        {
            body = await conn.ReadBodyAsync(request);
        }
        catch (InvalidDataException e)
        {
            await WriteAsync(stream, 400, Encoding.UTF8.GetBytes("{\"error\":\"" + e.Message + "\"}"), false);
            return false;
        }

        var keepAlive = request.KeepAlive;
        var health = request.Method == "GET" && request.Path == "/token-guard/health";
        var pre = request.Method == "POST" && request.Path == "/token-guard/pre";
        if (!health && !pre)
        {
            await WriteAsync(stream, 404, NotFoundBody, keepAlive);
        }
        else if (!TokenOk(request))
        {
            await WriteAsync(stream, 401, UnauthorizedBody, keepAlive);
        }
        else if (health)
        {
            await WriteAsync(stream, 200, Encoding.UTF8.GetBytes("{\"ok\":true,\"pid\":" + Environment.ProcessId.ToString(CultureInfo.InvariantCulture) + ",\"impl\":\"csharp\"}"), keepAlive);
        }
        else
        {
            var (status, reply, rule) = Pre(body);
            await WriteAsync(stream, status, reply, keepAlive, rule);
        }
        return keepAlive;
    }

    /// <summary>The PreToolUse route: 400 for a body that is not JSON, otherwise 200 with the envelope; any failure while deciding releases the call.</summary>
    static (int Status, byte[] Body, string? Rule) Pre(byte[] body)
    {
        object? payload;
        try
        {
            payload = Json.Parse(Encoding.UTF8.GetString(body));
        }
        catch (JsonParseException)
        {
            return (400, InvalidJsonBody, null);
        }
        catch (JsonTooDeepException)
        {
            return (200, EmptyBody, null);
        }
        try
        {
            var verdict = Decide.Run(payload);
            return verdict is null ? (200, EmptyBody, null) : (200, Encoding.UTF8.GetBytes(Decide.Envelope(verdict)), verdict.Rule);
        }
        catch
        {
            return (200, EmptyBody, null);
        }
    }

    /// <summary>The X-Token-Guard header against the launch token: SHA-256 digests compared in constant time.</summary>
    bool TokenOk(RequestHead request) =>
        CryptographicOperations.FixedTimeEquals(SHA256.HashData(Encoding.UTF8.GetBytes(request.Token)), _tokenDigest);

    static async Task WriteAsync(NetworkStream stream, int status, byte[] body, bool keepAlive, string? rule = null)
    {
        var head = Encoding.ASCII.GetBytes($"HTTP/1.1 {status} {Reason(status)}\r\nContent-Type: application/json\r\n{(rule is null ? "" : "x-tg-rule: " + rule + "\r\n")}Content-Length: {body.Length}\r\nConnection: {(keepAlive ? "keep-alive" : "close")}\r\n\r\n");
        var all = new byte[head.Length + body.Length];
        head.CopyTo(all, 0);
        body.CopyTo(all, head.Length);
        await stream.WriteAsync(all);
    }

    static string Reason(int status) => status switch
    {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        _ => "Status",
    };
}

/// <summary>The request line and the few headers the slice reads.</summary>
sealed class RequestHead
{
    public string Method = "";
    public string Path = "";
    public bool KeepAlive;
    public bool Expect100;
    public bool Chunked;
    public long? ContentLength;
    public string Token = "";

    /// <summary>Null when the request line or a Content-Length is malformed.</summary>
    public static RequestHead? Parse(string head)
    {
        var lineEnd = head.IndexOf("\r\n", StringComparison.Ordinal);
        var requestLine = lineEnd < 0 ? head : head[..lineEnd];
        var parts = requestLine.Split(' ');
        if (parts.Length != 3 || !parts[2].StartsWith("HTTP/1.", StringComparison.Ordinal))
        {
            return null;
        }
        var q = parts[1].IndexOf('?');
        var r = new RequestHead { Method = parts[0], Path = q >= 0 ? parts[1][..q] : parts[1] };
        var http10 = parts[2] == "HTTP/1.0";
        string? connection = null;
        for (var pos = lineEnd < 0 ? head.Length : lineEnd + 2; pos < head.Length;)
        {
            var end = head.IndexOf("\r\n", pos, StringComparison.Ordinal);
            if (end < 0)
            {
                end = head.Length;
            }
            var colon = head.IndexOf(':', pos, end - pos);
            if (colon > pos)
            {
                var name = head.AsSpan(pos, colon - pos).Trim();
                var value = head.AsSpan(colon + 1, end - colon - 1).Trim().ToString();
                if (name.Equals("content-length", StringComparison.OrdinalIgnoreCase))
                {
                    if (!long.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var length))
                    {
                        return null;
                    }
                    r.ContentLength = length;
                }
                else if (name.Equals("transfer-encoding", StringComparison.OrdinalIgnoreCase))
                {
                    r.Chunked = value.Contains("chunked", StringComparison.OrdinalIgnoreCase);
                }
                else if (name.Equals("connection", StringComparison.OrdinalIgnoreCase))
                {
                    connection = value;
                }
                else if (name.Equals("expect", StringComparison.OrdinalIgnoreCase))
                {
                    r.Expect100 = value.Equals("100-continue", StringComparison.OrdinalIgnoreCase);
                }
                else if (name.Equals("x-token-guard", StringComparison.OrdinalIgnoreCase))
                {
                    r.Token = r.Token.Length == 0 ? value : r.Token + ", " + value;
                }
            }
            pos = end + 2;
        }
        r.KeepAlive = connection is null
            ? !http10
            : http10 ? connection.Contains("keep-alive", StringComparison.OrdinalIgnoreCase) : !connection.Contains("close", StringComparison.OrdinalIgnoreCase);
        return r;
    }
}

/// <summary>Buffered reader over one connection: the header block, CRLF lines and exact-length bodies.</summary>
sealed class Connection(Stream stream)
{
    const int MaxHeadBytes = 64 * 1024;
    const int MaxBodyBytes = 256 * 1024 * 1024;
    byte[] _buf = new byte[4096];
    int _pos;
    int _len;

    /// <summary>Makes room and reads more bytes; false when the peer closed.</summary>
    async ValueTask<bool> FillAsync()
    {
        if (_pos == _len)
        {
            _pos = _len = 0;
        }
        else if (_len == _buf.Length)
        {
            if (_pos > 0)
            {
                Buffer.BlockCopy(_buf, _pos, _buf, 0, _len - _pos);
                _len -= _pos;
                _pos = 0;
            }
            else
            {
                Array.Resize(ref _buf, _buf.Length * 2);
            }
        }
        var n = await stream.ReadAsync(_buf.AsMemory(_len));
        _len += n;
        return n > 0;
    }

    /// <summary>The request line and headers without the blank line; null when the peer closed between requests.</summary>
    public async Task<string?> ReadHeadAsync()
    {
        var scanned = 0;
        while (true)
        {
            var window = _buf.AsSpan(_pos, _len - _pos);
            var idx = window[Math.Max(0, scanned - 3)..].IndexOf("\r\n\r\n"u8);
            if (idx >= 0)
            {
                var end = Math.Max(0, scanned - 3) + idx;
                var head = Encoding.Latin1.GetString(window[..end]);
                _pos += end + 4;
                return head;
            }
            scanned = window.Length;
            if (scanned > MaxHeadBytes)
            {
                throw new InvalidDataException("headers over 64 KB");
            }
            if (!await FillAsync())
            {
                return scanned == 0 ? null : throw new InvalidDataException("connection closed inside the headers");
            }
        }
    }

    public async Task<byte[]> ReadBodyAsync(RequestHead request)
    {
        if (request.Chunked)
        {
            using var body = new MemoryStream();
            while (true)
            {
                var sizeLine = await ReadLineAsync();
                var semi = sizeLine.IndexOf(';');
                if (!long.TryParse(semi >= 0 ? sizeLine[..semi].Trim() : sizeLine.Trim(), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out var size) || size < 0)
                {
                    throw new InvalidDataException("bad chunk size");
                }
                if (size == 0)
                {
                    while ((await ReadLineAsync()).Length > 0)
                    {
                    }
                    return body.ToArray();
                }
                if (body.Length + size > MaxBodyBytes)
                {
                    throw new InvalidDataException("body too large");
                }
                body.Write(await ReadExactAsync((int)size));
                await ReadLineAsync();
            }
        }
        if (request.ContentLength is { } length)
        {
            if (length > MaxBodyBytes)
            {
                throw new InvalidDataException("body too large");
            }
            return await ReadExactAsync((int)length);
        }
        return [];
    }

    async Task<string> ReadLineAsync()
    {
        var scanned = 0;
        while (true)
        {
            var window = _buf.AsSpan(_pos, _len - _pos);
            var idx = window[scanned..].IndexOf((byte)'\n');
            if (idx >= 0)
            {
                var end = scanned + idx;
                var lineLength = end > 0 && window[end - 1] == '\r' ? end - 1 : end;
                var line = Encoding.Latin1.GetString(window[..lineLength]);
                _pos += end + 1;
                return line;
            }
            scanned = window.Length;
            if (scanned > MaxHeadBytes)
            {
                throw new InvalidDataException("chunk line too long");
            }
            if (!await FillAsync())
            {
                throw new InvalidDataException("connection closed inside a chunked body");
            }
        }
    }

    async Task<byte[]> ReadExactAsync(int count)
    {
        var result = new byte[count];
        var have = Math.Min(count, _len - _pos);
        Buffer.BlockCopy(_buf, _pos, result, 0, have);
        _pos += have;
        while (have < count)
        {
            var n = await stream.ReadAsync(result.AsMemory(have));
            if (n <= 0)
            {
                throw new InvalidDataException("connection closed inside the body");
            }
            have += n;
        }
        return result;
    }
}
