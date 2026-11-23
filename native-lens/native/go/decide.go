package main

// The decision: triage by tool name, then the four rules in registry order, first hit wins. Any internal
// failure releases the call.

type verdict struct{ rule, reason string }

const hintSuffix = "\n[dica: rode `npx @allansantos-dev/token-guard audit` uma vez — com as estatísticas em cache " +
	"o guard calibra os limites ao tamanho real deste repositório.]"

var registry = []func(*ctx) *hit{ruleNoisePath, ruleBlindRead, ruleBroadScan, ruleShellDump}

// evaluate runs the rules; a rule that panics counts as no hit and the next one still runs.
func evaluate(c *ctx) *hit {
	for _, rule := range registry {
		if h := runRule(rule, c); h != nil {
			return h
		}
	}
	return nil
}

func runRule(rule func(*ctx) *hit, c *ctx) (h *hit) {
	defer func() {
		if recover() != nil {
			h = nil
		}
	}()
	return rule(c)
}

// decide returns nil to release the call, or the deny verdict.
func decide(payload any) (v *verdict) {
	defer func() {
		if recover() != nil {
			v = nil
		}
	}()
	name := toolName(payload)
	if !isWatched(name) {
		return nil
	}
	root := payloadCwd(payload)
	c := &ctx{name: name, input: toolInput(payload), root: root, stats: repoStats(root)}
	h := evaluate(c)
	if h == nil {
		return nil
	}
	suffix := ""
	if !truthy(c.stats) {
		suffix = hintSuffix
	}
	return &verdict{rule: h.id, reason: h.reason + suffix}
}

// envelope is the PreToolUse answer: {} to allow, the deny envelope otherwise.
func envelope(v *verdict) string {
	if v == nil {
		return "{}"
	}
	return `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":` +
		jsQuote(v.reason) + `}}`
}
