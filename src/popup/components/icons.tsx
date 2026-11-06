import React from 'react';

// One icon set for the whole UI: outline icons on a 24px grid with the same stroke weight and
// rounded ends. Play and pause are filled, as on any player.

interface IconProps {
  size?: number;
}

const Outline: React.FC<IconProps & { children: React.ReactNode }> = ({ size = 18, children }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

export const DownloadIcon: React.FC<IconProps> = (props) => (
  <Outline {...props}>
    <path d="M12 4v11" />
    <path d="M7.5 10.5L12 15l4.5-4.5" />
    <path d="M5 19.5h14" />
  </Outline>
);

export const TrashIcon: React.FC<IconProps> = (props) => (
  <Outline {...props}>
    <path d="M4.5 7h15" />
    <path d="M9.5 7V5a1 1 0 011-1h3a1 1 0 011 1v2" />
    <path d="M6.5 7l.8 11.2A2 2 0 009.3 20h5.4a2 2 0 002-1.8L17.5 7" />
    <path d="M10.5 11v5M13.5 11v5" />
  </Outline>
);

export const SkipBackIcon: React.FC<IconProps> = (props) => (
  <Outline {...props}>
    <path d="M6 5.5v13" />
    <path d="M18 6.4v11.2a.8.8 0 01-1.25.66L9.5 13.3a1.6 1.6 0 010-2.6l7.25-4.96A.8.8 0 0118 6.4z" />
  </Outline>
);

export const LoopIcon: React.FC<IconProps> = (props) => (
  <Outline {...props}>
    <path d="M16.5 3l3 3-3 3" />
    <path d="M4.5 11V9.5A3.5 3.5 0 018 6h11.5" />
    <path d="M7.5 21l-3-3 3-3" />
    <path d="M19.5 13v1.5A3.5 3.5 0 0116 18H4.5" />
  </Outline>
);

export const ZoomInIcon: React.FC<IconProps> = (props) => (
  <Outline {...props}>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="M20 20l-4.8-4.8" />
    <path d="M10.5 7.75v5.5M7.75 10.5h5.5" />
  </Outline>
);

export const ZoomOutIcon: React.FC<IconProps> = (props) => (
  <Outline {...props}>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="M20 20l-4.8-4.8" />
    <path d="M7.75 10.5h5.5" />
  </Outline>
);

export const MarkerIcon: React.FC<IconProps> = (props) => (
  <Outline {...props}>
    <path d="M5.5 21V4" />
    <path d="M5.5 4.5h12l-2.6 4 2.6 4h-12" />
  </Outline>
);

export const PlayIcon: React.FC<IconProps> = ({ size = 22 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M8 5.6v12.8a1 1 0 001.52.85l10.16-6.4a1 1 0 000-1.7L9.52 4.75A1 1 0 008 5.6z" />
  </svg>
);

export const PauseIcon: React.FC<IconProps> = ({ size = 22 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <rect x="6" y="4.5" width="4" height="15" rx="1.2" />
    <rect x="14" y="4.5" width="4" height="15" rx="1.2" />
  </svg>
);
