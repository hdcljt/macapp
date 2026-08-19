/// <reference types="vite/client" />

interface Window {
  electronAPI: {
    platform: NodeJS.Platform;
    minimize: () => void;
    maximize: () => void;
    close: () => void;
    versions: {
      node: string;
      chrome: string;
      electron: string;
    };
  };
}
