package main

// The runtime-agnostic payload readers: every harness spelling of tool name, input and working directory.

func firstStr(vals ...any) string {
	for _, v := range vals {
		if s, ok := v.(string); ok && s != "" {
			return s
		}
	}
	return ""
}

func firstObj(vals ...any) map[string]any {
	for _, v := range vals {
		if m, ok := v.(map[string]any); ok {
			return m
		}
	}
	return nil
}

func toolName(p any) string {
	return firstStr(get(get(p, "toolCall"), "toolName"), get(p, "tool_name"), get(p, "toolName"), get(p, "name"))
}

// parseArgs reads Copilot's toolArgs when it arrives as a JSON string.
func parseArgs(raw any) map[string]any {
	s, ok := raw.(string)
	if !ok {
		return nil
	}
	v, err := parseJSON([]byte(s))
	if err != nil {
		return nil
	}
	return firstObj(v)
}

func toolInput(p any) map[string]any {
	if m := firstObj(get(get(p, "toolCall"), "input"), get(p, "tool_input"), get(p, "toolInput"), get(p, "toolArgs"), get(p, "input")); m != nil {
		return m
	}
	if m := parseArgs(get(p, "toolArgs")); m != nil {
		return m
	}
	return map[string]any{}
}

func payloadCwd(p any) string {
	return firstStr(get(p, "cwd"), get(p, "workingDirectory"), get(p, "workspaceRoot"), get(p, "workspace_root"), cwd())
}

func inputPath(in map[string]any) string {
	return firstStr(in["path"], in["filePath"], in["file_path"], in["absolute_path"], in["target"], in["file"], in["uri"], in["filename"])
}

func notNull(v any) bool { return v != nil }

func inputPaths(in map[string]any) []string {
	var raw any
	switch {
	case notNull(in["paths"]):
		raw = in["paths"]
	case notNull(in["path"]):
		raw = in["path"]
	case notNull(in["searchPaths"]):
		raw = in["searchPaths"]
	default:
		raw = in["directories"]
	}
	switch t := raw.(type) {
	case []any:
		out := []string{}
		for _, e := range t {
			if s, ok := e.(string); ok {
				out = append(out, s)
			}
		}
		return out
	case string:
		if t != "" {
			return []string{t}
		}
	}
	return nil
}

func inputPattern(in map[string]any) string {
	return firstStr(in["pattern"], in["query"], in["regex"], in["search"], in["searchText"], in["glob"])
}

func inputScopeFilter(in map[string]any) string {
	return firstStr(in["glob"], in["type"], in["include"], in["includePattern"], in["filePattern"])
}

func isNonEmptyArray(v any) bool {
	a, ok := v.([]any)
	return ok && len(a) > 0
}

// hasReadRange is true when the read asked for a line range rather than the whole file.
func hasReadRange(in map[string]any) bool {
	if isNonEmptyArray(in["view_range"]) || isNonEmptyArray(in["range"]) {
		return true
	}
	if s, ok := in["pages"].(string); ok && jsTrim(s) != "" {
		return true
	}
	for _, k := range []string{"offset", "limit", "startLine", "endLine", "start_line", "end_line", "startLineNumber", "endLineNumber", "head", "tail"} {
		if f, ok := isFiniteNumber(in[k]); ok && f > 0 {
			return true
		}
	}
	return false
}

func inputCommand(in map[string]any) string {
	return firstStr(in["command"], in["cmd"], in["script"], in["commandLine"])
}
