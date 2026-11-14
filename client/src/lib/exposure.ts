import type { Exposure, ExposureVerdict } from '../types'

// Architecture exposure: wording and colour for each level. Mirrors EXPOSURE_LABEL in server/src/pipeline/score.ts.

export const EXPOSURE_ORDER: Exposure[] = ['public', 'unknown', 'login', 'internal', 'offline', 'unreached']

export const EXPOSURE_TEXT: Record<Exposure, { en: string; hi: string; short: string; blurb: string; tone: 'critical' | 'high' | 'info' | 'ok' | 'neutral' }> = {
  public: { en: 'Reachable from the internet', hi: 'इंटरनेट से पहुँच', short: 'Internet', blurb: 'An entry point that anyone on the internet can call loads this package.', tone: 'critical' },
  unknown: { en: 'Exposure unknown', hi: 'पहुँच अज्ञात', short: 'Unknown', blurb: 'No deployment file says where it runs, so Vulnera assumes it is internet-facing (the CISA SSVC default).', tone: 'high' },
  login: { en: 'Behind login', hi: 'लॉगिन के पीछे', short: 'Login', blurb: 'Only code mounted behind an auth middleware loads it: an attacker needs a valid account or token first.', tone: 'info' },
  internal: { en: 'Private network only', hi: 'सिर्फ़ निजी नेटवर्क', short: 'Internal', blurb: 'Only a process that publishes no port, or sits on an internal network, loads it.', tone: 'info' },
  offline: { en: 'No network entry point', hi: 'कोई नेटवर्क रास्ता नहीं', short: 'Offline', blurb: 'Only a scheduled job or command-line tool loads it: it takes no requests.', tone: 'ok' },
  unreached: { en: 'Not loaded by any entry point', hi: 'कोई एंट्री पॉइंट इसे नहीं चलाता', short: 'Unreached', blurb: 'No deployed entry point imports it, directly or through other files (VEX: vulnerable code not in execute path).', tone: 'ok' },
}

export const SSVC_TEXT: Record<ExposureVerdict['ssvc'], string> = {
  open: 'SSVC exposure: open',
  controlled: 'SSVC exposure: controlled',
  small: 'SSVC exposure: small',
}

/** Levels that can move a finding down one step (never KEV, never below Plan). */
export const LOWERING: Exposure[] = ['login', 'internal', 'offline', 'unreached']
