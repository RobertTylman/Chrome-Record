// Shared download helpers for the popup and the export tab
import { DEFAULT_AUDIO_FORMAT, getFileExtension } from './formatUtils';
import { ExportOptions } from './audioConverter';

// Exports longer than this run in their own tab: the popup closes (and cancels work)
// as soon as the user clicks anywhere else
export const INLINE_EXPORT_MAX_SECONDS = 120;

export async function getExportOptions(): Promise<ExportOptions> {
  const { preferences = {} } = await chrome.storage.local.get(['preferences']);
  const channelMode = preferences.channelMode;
  return {
    format: preferences.format || DEFAULT_AUDIO_FORMAT,
    sampleRate: preferences.sampleRate ? parseInt(preferences.sampleRate) : undefined,
    channels: channelMode === 'mono' ? 1 : channelMode === 'stereo' ? 2 : undefined,
    bitDepth: preferences.bitDepth ? parseInt(preferences.bitDepth) : 16,
    normalize: !!preferences.normalize
  };
}

// A recording's name without its audio extension. Only audio extensions are removed: tab-title
// names ("Dr. Who - Episode 1.5 - YouTube") have dots but no extension
export function withoutAudioExtension(name: string): string {
  return name.replace(/\.(wav|mp3|ogg|webm)$/i, '');
}

export function exportFilename(name: string, format: string): string {
  const nameWithoutExt = withoutAudioExtension(name || 'recording');
  const sanitized = nameWithoutExt.replace(/[\/\\:*?"<>|]/g, '_');
  return `${sanitized}.${getFileExtension(format)}`;
}

export function shouldExportInTab(duration: number): boolean {
  return !(duration > 0 && duration <= INLINE_EXPORT_MAX_SECONDS);
}

export function openExportTab(params: { ids: string[]; start?: number; end?: number; all?: boolean }) {
  const query = new URLSearchParams();
  query.set('ids', params.ids.join(','));
  if (params.start) query.set('start', String(params.start));
  if (params.end) query.set('end', String(params.end));
  if (params.all) query.set('all', '1');
  chrome.tabs.create({ url: chrome.runtime.getURL(`export.html?${query.toString()}`) });
}
