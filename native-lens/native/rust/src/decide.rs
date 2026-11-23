//! Port of `lib/decide.cjs` plus the `repoStats` lookup of `lib/config.cjs`.

use crate::json::{parse, Value};
use crate::jspath::join;
use crate::payload as p;
use crate::rules::{evaluate, rx, Ctx, Stats};
use crate::statedir::state_dir;

/// A deny: the rule that fired and the full reason text.
pub struct Verdict {
    pub rule: &'static str,
    pub reason: String,
}

const DICA: &str = "\n[dica: rode `npx @allansantos-dev/token-guard audit` uma vez \u{2014} com as estat\u{ed}sticas em cache \
o guard calibra os limites ao tamanho real deste reposit\u{f3}rio.]";

/// Cached repository statistics for `root`; `None` when absent, unreadable, not JSON or falsy.
fn repo_stats(root: &str) -> Stats {
    let file = join(&[&state_dir(root), "repo-stats.json"]);
    let bytes = std::fs::read(file).ok()?;
    match parse(&String::from_utf8_lossy(&bytes)) {
        Ok(v) if v.truthy() => Some(v),
        _ => None,
    }
}

/// Decides one PreToolUse payload. `None` allows the call; any unexpected shape allows it too.
pub fn decide(payload: &Value) -> Option<Verdict> {
    let name = p::tool_name(payload);
    if name.is_empty() || !rx().watched.test_str(&name) {
        return None;
    }
    let root = p::cwd(payload)?;
    let input = p::tool_input(payload);
    let stats = repo_stats(&root);
    let hit = evaluate(&Ctx { name: &name, input: &input, root: &root, stats: &stats })?;
    let suffix = if stats.is_some() { "" } else { DICA };
    Some(Verdict { rule: hit.id, reason: format!("{}{suffix}", hit.reason) })
}
