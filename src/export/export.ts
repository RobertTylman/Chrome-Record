// Export tab: converts and downloads recordings outside the popup, which Chrome closes
// (cancelling any work) as soon as the user clicks elsewhere.
import JSZip from 'jszip';
import { exportAudio, estimateExportSize } from '../popup/utils/audioConverter';
import { downloadAudio } from '../popup/utils/audioUtils';
import { exportFilename, getExportOptions } from '../popup/utils/exportUtils';
import { getRecording, RecordingMetadata } from '../popup/utils/storageManager';

// Above this, "Download all" saves files one by one instead of building a zip in memory
const MAX_ZIP_BYTES = 1024 * 1024 * 1024;

const params = new URLSearchParams(location.search);
const ids = (params.get('ids') || '').split(',').filter(Boolean);
const start = params.get('start') ? Number(params.get('start')) : undefined;
const end = params.get('end') ? Number(params.get('end')) : undefined;
const isDownloadAll = params.get('all') === '1';

const titleEl = document.getElementById('title')!;
const hintEl = document.getElementById('hint')!;
const itemsEl = document.getElementById('items')!;
const summaryEl = document.getElementById('summary')!;

let exporting = false;
window.addEventListener('beforeunload', (event) => {
  if (exporting) event.preventDefault();
});

function addItemRow(name: string) {
  const row = document.createElement('div');
  row.className = 'item';
  row.innerHTML = '<div class="item-name"></div><div class="bar"><div></div></div><div class="item-status">Waiting…</div>';
  row.querySelector('.item-name')!.textContent = name;
  itemsEl.appendChild(row);
  const fill = row.querySelector('.bar > div') as HTMLDivElement;
  const status = row.querySelector('.item-status') as HTMLDivElement;
  return {
    progress(fraction: number) {
      fill.style.width = `${Math.round(fraction * 100)}%`;
      status.textContent = `Converting… ${Math.round(fraction * 100)}%`;
    },
    done(text: string) {
      fill.style.width = '100%';
      status.textContent = text;
    },
    fail(text: string) {
      status.textContent = text;
      status.classList.add('error');
    }
  };
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function run() {
  const options = await getExportOptions();
  const recordings: RecordingMetadata[] = [];
  for (const id of ids) {
    const recording = await getRecording(id);
    if (recording) recordings.push(recording.metadata);
  }
  if (recordings.length === 0) {
    titleEl.textContent = 'Recording not found';
    hintEl.textContent = 'It may have been deleted.';
    return;
  }

  const estimatedTotal = recordings.reduce((sum, r) => sum + estimateExportSize(r.duration || 0, options), 0);
  const useZip = isDownloadAll && recordings.length > 1 && estimatedTotal <= MAX_ZIP_BYTES;
  const zip = useZip ? new JSZip() : null;
  const usedFilenames = new Set<string>();
  const rows = recordings.map(r => addItemRow(r.name.replace(/\.[^/.]+$/, '')));
  let failures = 0;

  titleEl.textContent = recordings.length > 1
    ? `Exporting ${recordings.length} recordings as ${options.format.toUpperCase()}`
    : `Exporting as ${options.format.toUpperCase()}`;
  if (isDownloadAll && !useZip && recordings.length > 1) {
    hintEl.textContent = `About ${formatBytes(estimatedTotal)} in total, too large for one zip, so each recording downloads separately. Chrome may ask to allow multiple downloads.`;
  }

  exporting = true;
  for (let i = 0; i < recordings.length; i++) {
    const metadata = recordings[i];
    const row = rows[i];
    try {
      const recording = await getRecording(metadata.id);
      if (!recording) throw new Error('Recording not found');

      const blob = await exportAudio(recording.audio, {
        ...options,
        start: recordings.length === 1 ? start : undefined,
        end: recordings.length === 1 ? end : undefined,
        duration: metadata.duration,
        onProgress: (fraction) => {
          row.progress(fraction);
          const overall = (i + fraction) / recordings.length;
          document.title = `${Math.round(overall * 100)}% - Exporting`;
        }
      });

      let filename = exportFilename(metadata.name, options.format);
      if (zip) {
        const base = filename.replace(/\.[^/.]+$/, '');
        const ext = filename.slice(base.length);
        let counter = 1;
        while (usedFilenames.has(filename.toLowerCase())) filename = `${base} (${counter++})${ext}`;
        usedFilenames.add(filename.toLowerCase());
        zip.file(filename, blob);
        row.done(`Converted (${formatBytes(blob.size)})`);
      } else {
        downloadAudio(blob, filename);
        row.done(`Downloaded ${filename} (${formatBytes(blob.size)})`);
      }
    } catch (error: any) {
      console.error(`Error exporting ${metadata.name}:`, error);
      failures++;
      row.fail(`Failed: ${error?.message || 'Unknown error'}`);
    }
  }

  if (zip && failures < recordings.length) {
    summaryEl.textContent = 'Building zip…';
    // Audio is already compressed or PCM; storing avoids slow, pointless deflate
    const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
    downloadAudio(zipBlob, `chrome-recorder-${new Date().toISOString().split('T')[0]}.zip`);
  }

  exporting = false;
  document.title = failures ? 'Export finished with errors' : 'Export complete';
  titleEl.textContent = failures ? `Export finished, ${failures} failed` : 'Download started';
  hintEl.textContent = 'You can close this tab once the download has finished.';
  summaryEl.textContent = '';
}

// Holding a Web Lock keeps Chrome from freezing this tab while it is in the background
const locks = (navigator as any).locks;
const task = () => run().catch((error) => {
  exporting = false;
  console.error('Export failed:', error);
  titleEl.textContent = 'Export failed';
  hintEl.textContent = error?.message || 'Unknown error';
});
if (locks?.request) {
  locks.request(`chrome-recorder-export-${Date.now()}`, task);
} else {
  task();
}
