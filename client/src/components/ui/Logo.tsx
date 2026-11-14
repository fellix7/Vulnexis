// Mark: a shield holding the three narrowing bars: many alerts in, one decision out.
export function LogoMark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d="M10 1.2l7.4 2.7v5.3c0 4.6-3.1 7.8-7.4 9.4-4.3-1.6-7.4-4.8-7.4-9.4V3.9L10 1.2z" fill="none" stroke="currentColor" strokeOpacity="0.45" strokeWidth="1.4" />
      <rect x="5.6" y="5.6" width="8.8" height="2.2" rx="0.8" fill="currentColor" opacity="0.45" />
      <rect x="7.1" y="9.2" width="5.8" height="2.2" rx="0.8" fill="currentColor" opacity="0.75" />
      <rect x="8.7" y="12.8" width="2.6" height="2.2" rx="0.8" fill="var(--accent)" />
    </svg>
  )
}

export function Logo({ size = 20 }: { size?: number }) {
  return (
    <span className="logo" style={{ display: 'inline-flex', alignItems: 'center', gap: 9, color: 'var(--text)' }}>
      <LogoMark size={size} />
      <span style={{ fontWeight: 650, fontSize: size * 0.82, letterSpacing: '-0.03em', lineHeight: 1 }}>vulnera</span>
    </span>
  )
}
