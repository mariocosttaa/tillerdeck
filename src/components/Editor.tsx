import { useEffect, useRef } from "react";
import MonacoEditor, { type OnMount } from "@monaco-editor/react";
import { parseDocument } from "yaml";
import { monaco } from "../monaco";
import type { LintIssue } from "../api";

export interface OpenFile {
  path: string;
  /** O texto como está no disco (ou decifrado, para um vault). */
  saved: string;
  content: string;
  vault: boolean;
  lint?: LintIssue[];
}

function languageFor(path: string): string {
  const lower = path.toLowerCase();
  if (/\.ya?ml$/.test(lower)) return "yaml";
  if (/\.(ini|cfg)$/.test(lower) || /(^|\/)(hosts|inventory)$/.test(lower)) return "ini";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".md")) return "markdown";
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".sh")) return "shell";
  if (/(^|\/)makefile$/.test(lower) || lower.endsWith(".mk")) return "makefile";
  if (lower.endsWith(".j2")) return lower.includes(".yml.") || lower.includes(".yaml.") ? "yaml" : "plaintext";
  return "plaintext";
}

/** Erros de YAML vistos pela mesma biblioteca que valida antes de gravar. */
export function yamlErrors(path: string, text: string): string[] {
  if (languageFor(path) !== "yaml" || path.endsWith(".j2")) return [];
  const doc = parseDocument(text, { prettyErrors: true, uniqueKeys: true });
  return doc.errors.map((e) => e.message);
}

interface Props {
  file: OpenFile;
  dark: boolean;
  onChange: (text: string) => void;
  onSave: () => void;
}

export default function Editor({ file, dark, onChange, onSave }: Props) {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const saveRef = useRef(onSave);
  saveRef.current = onSave;

  const onMount: OnMount = (editor) => {
    editorRef.current = editor;
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current());
    applyLint();
  };

  function applyLint() {
    const model = editorRef.current?.getModel();
    if (!model) return;
    monaco.editor.setModelMarkers(
      model,
      "ansible-lint",
      (file.lint ?? []).map((i) => ({
        startLineNumber: i.line,
        endLineNumber: i.line,
        startColumn: i.column,
        endColumn: model.getLineMaxColumn(Math.min(i.line, model.getLineCount())),
        message: `${i.message}`,
        source: `ansible-lint · ${i.rule}`,
        severity:
          i.severity === "blocker" || i.severity === "critical" || i.severity === "major"
            ? monaco.MarkerSeverity.Error
            : monaco.MarkerSeverity.Warning,
      })),
    );
  }

  useEffect(applyLint, [file.lint, file.path]);

  return (
    <MonacoEditor
      // Um model por caminho: cada separador guarda o seu undo e o seu scroll.
      path={`file:///${file.vault ? "vault/" : ""}${file.path}`}
      language={languageFor(file.path)}
      value={file.content}
      theme={dark ? "vs-dark" : "vs"}
      onChange={(v) => onChange(v ?? "")}
      onMount={onMount}
      options={{
        fontSize: 13,
        fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
        minimap: { enabled: true, renderCharacters: false },
        tabSize: 2,
        insertSpaces: true,
        renderWhitespace: "boundary",
        rulers: [120],
        scrollBeyondLastLine: false,
        automaticLayout: true,
        wordWrap: "off",
        quickSuggestions: { other: true, comments: false, strings: true },
      }}
    />
  );
}
