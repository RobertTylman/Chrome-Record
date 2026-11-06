import React, { useState, useEffect, useRef } from 'react';
import { DownloadIcon, TrashIcon } from './icons';
import { formatDate } from '../utils/audioUtils';

interface AudioInfoProps {
  recordingName: string;
  timestamp: Date;
  onDownload?: () => void;
  onDelete?: () => void;
  onNameChange?: (newName: string) => void;
}

export const AudioInfo: React.FC<AudioInfoProps> = ({
  recordingName,
  timestamp,
  onDownload,
  onDelete,
  onNameChange
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editedName, setEditedName] = useState(recordingName.replace(/\.[^/.]+$/, ''));
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Update edited name when recordingName prop changes
    setEditedName(recordingName.replace(/\.[^/.]+$/, ''));
  }, [recordingName]);

  useEffect(() => {
    // Focus input when editing starts
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleNameClick = () => {
    if (onNameChange) {
      setIsEditing(true);
    }
  };

  const handleNameBlur = () => {
    setIsEditing(false);
    const trimmedName = editedName.trim();
    if (trimmedName && trimmedName !== recordingName.replace(/\.[^/.]+$/, '') && onNameChange) {
      onNameChange(trimmedName);
    } else if (!trimmedName) {
      // Reset to original if empty
      setEditedName(recordingName.replace(/\.[^/.]+$/, ''));
    }
  };

  const handleNameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      inputRef.current?.blur();
    } else if (e.key === 'Escape') {
      setEditedName(recordingName.replace(/\.[^/.]+$/, ''));
      inputRef.current?.blur();
    }
  };

  return (
    <div className="audio-info">
      {isEditing ? (
        <input
          ref={inputRef}
          type="text"
          className="recording-name-input"
          value={editedName}
          onChange={(e) => setEditedName(e.target.value)}
          onBlur={handleNameBlur}
          onKeyDown={handleNameKeyDown}
        />
      ) : (
        <span 
          className="recording-name" 
          onClick={handleNameClick}
          style={{ cursor: onNameChange ? 'text' : 'default' }}
          title={onNameChange ? 'Click to edit name' : ''}
        >
          {editedName}
        </span>
      )}
      <div className="audio-actions">
        {onDownload && (
          <button className="icon-button has-tooltip tooltip-below" onClick={onDownload} aria-label="Download" data-tooltip="Download">
            <DownloadIcon />
          </button>
        )}
        {onDelete && (
          <button className="icon-button delete-button has-tooltip tooltip-below tooltip-end" onClick={onDelete} aria-label="Delete" data-tooltip="Delete">
            <TrashIcon />
          </button>
        )}
      </div>
    </div>
  );
};

