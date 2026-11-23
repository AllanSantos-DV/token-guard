namespace Slice;

/// <summary>A refusal: the rule that fired and the reason sent to the agent.</summary>
sealed record Verdict(string Rule, string Reason);

/// <summary>The decision of <c>decide.cjs</c> with the default configuration, and the PreToolUse envelope of <c>claude-hooks.cjs</c>.</summary>
static class Decide
{
    const string Tip =
        "\n[dica: rode `npx @allansantos-dev/token-guard audit` uma vez — com as estatísticas em cache " +
        "o guard calibra os limites ao tamanho real deste repositório.]";

    static readonly Rx Watched = new("(view|read|grep|glob|search|list_dir|list_files|list_director|bash|shell|powershell|pwsh|terminal|run_command|execute_command|find_files|cat_file|open_file|ripgrep)", true);

    /// <summary>Null releases the call. Any internal error releases it too: a hostile payload never blocks.</summary>
    public static Verdict? Run(object? payload)
    {
        try
        {
            var name = Payload.ToolName(payload);
            if (name.Length == 0 || !Watched.IsMatch(name))
            {
                return null;
            }
            var root = Payload.Cwd(payload);
            var input = Payload.ToolInput(payload);
            var stats = Host.RepoStats(root);
            var hit = Rules.Evaluate(name, input, root, stats);
            return hit is null ? null : new Verdict(hit.Id, hit.Reason + (JsValue.Truthy(stats) ? "" : Tip));
        }
        catch
        {
            return null;
        }
    }

    /// <summary>The response body: <c>{}</c> to release, the hook deny envelope otherwise.</summary>
    public static string Envelope(Verdict? verdict) =>
        verdict is null
            ? "{}"
            : "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":" + Json.Quote(verdict.Reason) + "}}";
}
