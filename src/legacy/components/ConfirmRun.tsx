import { useEffect, useRef, useState } from "react";
import { t } from "../../v2/i18n";

export interface ConfirmRequest {
  title: string;
  command: string;
  /** Palavra a escrever para continuar (ex.: `production`). Sem ela, basta um clique. */
  word?: string;
  warnings: string[];
  details?: string[];
  onConfirm: () => void;
}

export default function ConfirmRun({ req, onClose }: { req: ConfirmRequest; onClose: () => void }) {
  const [typed, setTyped] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);
  const ok = !req.word || typed.trim() === req.word;

  useEffect(() => {
    (req.word ? inputRef.current : okRef.current)?.focus();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [req, onClose]);

  function go() {
    if (!ok) return;
    onClose();
    req.onConfirm();
  }

  return (
    <div className="modal-back" onMouseDown={onClose}>
      <div className={`modal ${req.word ? "danger" : ""}`} onMouseDown={(e) => e.stopPropagation()}>
        <h2>{req.title}</h2>
        {req.warnings.map((w) => (
          <p key={w} className="warn">⚠ {w}</p>
        ))}
        <pre className="cmd">{req.command}</pre>
        {req.details && req.details.length > 0 && <pre className="details">{req.details.join("\n")}</pre>}
        {req.word && (
          <label className="typed">
            <span>{t("Type")} <code>{req.word}</code> {t("to continue")}</span>
            <input
              ref={inputRef}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && go()}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
          </label>
        )}
        <div className="modal-actions">
          <button onClick={onClose}>{t("Cancel")}</button>
          <button ref={okRef} className={req.word ? "danger" : "primary"} disabled={!ok} onClick={go}>
            {t("Run")}
          </button>
        </div>
      </div>
    </div>
  );
}
