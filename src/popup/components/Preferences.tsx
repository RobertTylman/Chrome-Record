import React, { useState, useEffect } from 'react';
import { DEFAULT_AUDIO_FORMAT } from '../utils/formatUtils';

interface PreferencesProps {
  onClose?: () => void;
}

export const Preferences: React.FC<PreferencesProps> = ({ onClose }) => {
  const [format, setFormat] = useState<string>(DEFAULT_AUDIO_FORMAT);
  const [sampleRate, setSampleRate] = useState<string>('44100');
  const [channelMode, setChannelMode] = useState<string>('stereo');
  const [bitDepth, setBitDepth] = useState<string>('16');
  const [normalize, setNormalize] = useState<boolean>(false);
  const [useTabTitle, setUseTabTitle] = useState<boolean>(false);

  useEffect(() => {
    // Load saved preferences
    chrome.storage.local.get(['preferences'], (result) => {
      if (result.preferences) {
        const prefs = result.preferences;
        if (prefs.format) setFormat(prefs.format);
        if (prefs.sampleRate) setSampleRate(prefs.sampleRate);
        if (prefs.channelMode) setChannelMode(prefs.channelMode);
        if (prefs.bitDepth) setBitDepth(prefs.bitDepth);
        if (prefs.normalize !== undefined) setNormalize(prefs.normalize);
        if (prefs.useTabTitle !== undefined) setUseTabTitle(prefs.useTabTitle);
      }
    });
  }, []);

  const savePreferences = (
    newFormat?: string,
    newSampleRate?: string,
    newChannelMode?: string,
    newBitDepth?: string,
    newNormalize?: boolean,
    newUseTabTitle?: boolean
  ) => {
    chrome.storage.local.set({
      preferences: {
        format: newFormat !== undefined ? newFormat : format,
        sampleRate: newSampleRate !== undefined ? newSampleRate : sampleRate,
        channelMode: newChannelMode !== undefined ? newChannelMode : channelMode,
        bitDepth: newBitDepth !== undefined ? newBitDepth : bitDepth,
        normalize: newNormalize !== undefined ? newNormalize : normalize,
        useTabTitle: newUseTabTitle !== undefined ? newUseTabTitle : useTabTitle
      }
    });
  };

  const handleFormatChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newFormat = e.target.value;
    setFormat(newFormat);
    // Just save the preference - recordings are stored as WAV internally
    // and converted to this format only when downloaded
    savePreferences(newFormat);
  };

  const handleSampleRateChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newSampleRate = e.target.value;
    setSampleRate(newSampleRate);
    // Just save the preference - sample rate is applied when saving new recordings
    // and when downloading existing recordings
    savePreferences(undefined, newSampleRate);
  };

  const handleChannelModeChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newChannelMode = e.target.value;
    setChannelMode(newChannelMode);
    // Just save the preference - channel mode is applied when saving new recordings
    // and when downloading existing recordings
    savePreferences(undefined, undefined, newChannelMode);
  };

  const handleBitDepthChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newBitDepth = e.target.value;
    setBitDepth(newBitDepth);
    savePreferences(undefined, undefined, undefined, newBitDepth);
  };

  const handleNormalizeToggle = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newNormalize = e.target.checked;
    setNormalize(newNormalize);
    savePreferences(undefined, undefined, undefined, undefined, newNormalize);
  };

  const handleUseTabTitleToggle = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newUseTabTitle = e.target.checked;
    setUseTabTitle(newUseTabTitle);
    savePreferences(undefined, undefined, undefined, undefined, undefined, newUseTabTitle);
  };

  return (
    <div className="preferences">
      <div className="preference-item" title="Choose between mono (1 channel) or stereo (2 channels) audio">
        <label className="preference-label">mono/stereo</label>
        <select
          className="preference-select"
          value={channelMode}
          onChange={handleChannelModeChange}
        >
          <option value="mono">mono</option>
          <option value="stereo">stereo</option>
        </select>
      </div>

      <div className="preference-item" title="Audio file format for downloads (WAV: lossless, WebM/MP3/OGG: compressed)">
        <label className="preference-label">download file type</label>
        <select
          className="preference-select"
          value={format}
          onChange={handleFormatChange}
        >
          <option value="wav">wav</option>
          <option value="webm">webm</option>
          <option value="mp3">mp3</option>
          <option value="ogg">ogg</option>
        </select>
      </div>

      <div className="preference-item" title="Number of audio samples per second (higher = better quality, larger file)">
        <label className="preference-label">sample rate</label>
        <select
          className="preference-select"
          value={sampleRate}
          onChange={handleSampleRateChange}
        >
          <option value="44100">44100</option>
          <option value="48000">48000</option>
          <option value="96000">96000</option>
          <option value="192000">192000</option>
        </select>
      </div>

      <div className="preference-item" title="Bit depth controls dynamic range (16-bit: CD quality, 24-bit: studio quality, 32-bit: maximum precision). Only applies to WAV files.">
        <label className="preference-label">bit depth</label>
        <select
          className="preference-select"
          value={bitDepth}
          onChange={handleBitDepthChange}
        >
          <option value="16">16-bit</option>
          <option value="24">24-bit</option>
          <option value="32">32-bit</option>
        </select>
      </div>

      <div className="preference-item" title="Automatically adjust volume to maximize loudness without clipping">
        <label className="preference-label">normalize audio</label>
        <label className="toggle-switch">
          <input
            type="checkbox"
            checked={normalize}
            onChange={handleNormalizeToggle}
          />
          <span className="toggle-slider"></span>
        </label>
      </div>

      <div className="preference-item" title="Use the browser tab's title as the default recording name">
        <label className="preference-label">use tab title as sample name</label>
        <label className="toggle-switch">
          <input
            type="checkbox"
            checked={useTabTitle}
            onChange={handleUseTabTitleToggle}
          />
          <span className="toggle-slider"></span>
        </label>
      </div>
    </div>
  );
};
