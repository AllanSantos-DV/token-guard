using System;
using System.Globalization;
using System.Threading.Tasks;

namespace Slice;

/// <summary>Entry point: <c>slice --port N --token T</c>. Listens on 127.0.0.1 only, prints one READY line, serves until killed.</summary>
static class Program
{
    const string Usage = "usage: slice --port N --token T";

    static async Task<int> Main(string[] args)
    {
        string? Arg(string flag)
        {
            var i = Array.IndexOf(args, flag);
            return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
        }

        var token = Arg("--token");
        if (!int.TryParse(Arg("--port"), NumberStyles.None, CultureInfo.InvariantCulture, out var port) || port is < 1 or > 65535 || string.IsNullOrEmpty(token))
        {
            return Fatal(Usage, 2);
        }
        try
        {
            var server = HttpServer.Listen(port, token);
            Console.Out.WriteLine($"READY port={port} impl=csharp");
            Console.Out.Flush();
            await server.RunAsync();
            return 0;
        }
        catch (Exception e)
        {
            return Fatal($"{e.GetType().Name}: {e.Message}", 1);
        }
    }

    static int Fatal(string message, int code)
    {
        Console.Error.WriteLine("slice: " + message);
        return code;
    }
}
