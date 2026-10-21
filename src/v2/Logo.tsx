/** O símbolo da Tillerdeck: a pá do leme com a fenda e o pivot Maré, no tile Índigo. */
export function AppMark({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 1024 1024" aria-hidden className="shrink-0">
      <rect width="1024" height="1024" rx="225" fill="#6B5BF5" />
      <g transform="translate(157.65 165.03) scale(7.3823)">
        <path d="M14 12 H58 C78 12 90 24 90 44 V58 C90 78 78 90 58 90 H14 Z" fill="#FFFFFF" />
        <path d="M6 4 L50 48" stroke="#6B5BF5" strokeWidth="12" strokeLinecap="round" />
        <circle cx="50" cy="48" r="7" fill="#2CC4A4" />
      </g>
    </svg>
  );
}

/** O logótipo horizontal: símbolo e nome em caixa baixa, em Sora. */
export function Wordmark({ size = 24 }: { size?: number }) {
  return (
    <span className="inline-flex items-center" style={{ gap: size * 0.38 }}>
      <AppMark size={size * 1.25} />
      <span className="font-display" style={{ fontSize: size, lineHeight: 1, letterSpacing: "-0.02em" }}>tillerdeck</span>
    </span>
  );
}
