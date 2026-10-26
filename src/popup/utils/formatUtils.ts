// Format utilities for audio export

export const DEFAULT_AUDIO_FORMAT = 'wav';

export function getFileExtension(format: string): string {
  return format.toLowerCase();
}
