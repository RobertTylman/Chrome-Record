// Format utilities for audio recording

export const DEFAULT_AUDIO_FORMAT = 'wav';

export function getMimeTypeForFormat(format: string): string {
  // Map format to MIME type
  // Note: MediaRecorder has limited format support
  // Most browsers only support webm, some support ogg
  const formatMap: { [key: string]: string } = {
    'webm': 'audio/webm',
    'ogg': 'audio/ogg',
    'wav': 'audio/webm', // MediaRecorder doesn't support WAV, we'll convert later
    'mp3': 'audio/webm'  // MediaRecorder doesn't support MP3, we'll convert later
  };
  
  return formatMap[format.toLowerCase()] || 'audio/webm';
}

export function getFileExtension(format: string): string {
  return format.toLowerCase();
}

export function isFormatSupported(format: string): boolean {
  // Check if MediaRecorder supports this format
  const mimeType = getMimeTypeForFormat(format);
  
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) {
    return false;
  }
  
  // For wav and mp3, MediaRecorder doesn't support them natively
  // We'll record as webm and convert on download
  if (format === 'wav' || format === 'mp3') {
    return false;
  }
  
  return MediaRecorder.isTypeSupported(mimeType);
}

