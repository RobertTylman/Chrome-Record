// Theme names and the waveform colors for each

export type Theme = 'light' | 'dark' | 'midnight' | 'forest' | 'rainbow' | 'vintage';

// The order the header button cycles through
export const THEMES: Theme[] = ['light', 'dark', 'midnight', 'forest', 'rainbow', 'vintage'];

const WAVEFORM_COLORS: Record<Theme, { bar: string; background: string }> = {
  light: { bar: '#3b82f6', background: '#f5f5f5' },
  dark: { bar: '#4ade80', background: '#1f1f1f' },
  midnight: { bar: '#38bdf8', background: '#1e293b' },
  forest: { bar: '#fbbf24', background: '#064e3b' },
  rainbow: { bar: '#4ade80', background: '#1a1a1a' },
  // Dark trace on a warm backlit meter face
  vintage: { bar: '#3b2a1a', background: '#ecd9a0' }
};

export function waveformColors(theme: Theme) {
  return WAVEFORM_COLORS[theme] || WAVEFORM_COLORS.dark;
}
