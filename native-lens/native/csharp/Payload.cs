using System.Collections.Generic;

namespace Slice;

/// <summary>
/// Runtime-agnostic payload reader (<c>payload.cjs</c>): Copilot <c>toolCall</c>, Claude Code <c>tool_name/tool_input</c>,
/// camelCase legacy and the in-process <c>toolArgs</c>. A property read on anything that is not an object is JS
/// <c>undefined</c>, here null.
/// </summary>
static class Payload
{
    public static object? Get(object? o, string key) => o is JObj j && j.TryGetValue(key, out var v) ? v : null;

    public static string FirstString(params object?[] vals)
    {
        foreach (var v in vals)
        {
            if (v is string s && s.Length > 0)
            {
                return s;
            }
        }
        return "";
    }

    public static JObj? FirstObject(params object?[] vals)
    {
        foreach (var v in vals)
        {
            if (v is JObj j)
            {
                return j;
            }
        }
        return null;
    }

    public static string ToolName(object? payload) => FirstString(
        Get(Get(payload, "toolCall"), "toolName"),
        Get(payload, "tool_name"),
        Get(payload, "toolName"),
        Get(payload, "name"));

    public static JObj ToolInput(object? payload) =>
        FirstObject(
            Get(Get(payload, "toolCall"), "input"),
            Get(payload, "tool_input"),
            Get(payload, "toolInput"),
            Get(payload, "toolArgs"),
            Get(payload, "input"))
        ?? ParseArgs(Get(payload, "toolArgs"))
        ?? new JObj();

    /// <summary>The Copilot CLI command hook delivers <c>toolArgs</c> as a JSON string.</summary>
    static JObj? ParseArgs(object? raw)
    {
        if (raw is not string text)
        {
            return null;
        }
        try
        {
            return FirstObject(Json.Parse(text));
        }
        catch (JsonParseException)
        {
            return null;
        }
        catch (JsonTooDeepException)
        {
            return null;
        }
    }

    public static string Cwd(object? payload) => FirstString(
        Get(payload, "cwd"),
        Get(payload, "workingDirectory"),
        Get(payload, "workspaceRoot"),
        Get(payload, "workspace_root"),
        Host.Cwd);

    public static string InputPath(JObj input) => FirstString(
        Get(input, "path"), Get(input, "filePath"), Get(input, "file_path"), Get(input, "absolute_path"),
        Get(input, "target"), Get(input, "file"), Get(input, "uri"), Get(input, "filename"));

    /// <summary>List of paths (grep and glob accept a string or an array).</summary>
    public static List<string> InputPaths(JObj input)
    {
        var raw = Get(input, "paths") ?? Get(input, "path") ?? Get(input, "searchPaths") ?? Get(input, "directories");
        var result = new List<string>();
        if (raw is List<object?> list)
        {
            foreach (var item in list)
            {
                if (item is string s)
                {
                    result.Add(s);
                }
            }
        }
        else if (raw is string str && str.Length > 0)
        {
            result.Add(str);
        }
        return result;
    }

    public static string InputPattern(JObj input) => FirstString(
        Get(input, "pattern"), Get(input, "query"), Get(input, "regex"), Get(input, "search"), Get(input, "searchText"), Get(input, "glob"));

    /// <summary>Scope filter (glob/type/include): its presence is what makes a search acceptable.</summary>
    public static string InputScopeFilter(JObj input) => FirstString(
        Get(input, "glob"), Get(input, "type"), Get(input, "include"), Get(input, "includePattern"), Get(input, "filePattern"));

    /// <summary>True when the read asked for a line range instead of the whole file; offset=0 without limit is the whole file.</summary>
    public static bool HasReadRange(JObj input)
    {
        if (Get(input, "view_range") is List<object?> { Count: > 0 })
        {
            return true;
        }
        if (Get(input, "range") is List<object?> { Count: > 0 })
        {
            return true;
        }
        if (Get(input, "pages") is string pages && JsValue.Trim(pages).Length > 0)
        {
            return true;
        }
        foreach (var key in new[] { "offset", "limit", "startLine", "endLine", "start_line", "end_line", "startLineNumber", "endLineNumber", "head", "tail" })
        {
            if (Get(input, key) is double n && double.IsFinite(n) && n > 0)
            {
                return true;
            }
        }
        return false;
    }

    public static string InputCommand(JObj input) => FirstString(
        Get(input, "command"), Get(input, "cmd"), Get(input, "script"), Get(input, "commandLine"));
}
