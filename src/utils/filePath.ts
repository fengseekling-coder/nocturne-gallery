const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:[\\/]/;
const UNC_PATH_PATTERN = /^\\\\/;

export const normalizeTransferredFilePath = (rawValue: string): string | null => {
  const value = rawValue.trim();
  if (!value || value.startsWith('#')) return null;

  if (/^file:\/\//i.test(value)) {
    try {
      const decoded = decodeURI(value.replace(/^file:\/\//i, ''));
      if (decoded.startsWith('/') && /^[A-Za-z]:/.test(decoded.slice(1))) {
        return decoded.slice(1).replace(/\//g, '\\');
      }
      return decoded;
    } catch {
      return null;
    }
  }

  if (WINDOWS_ABSOLUTE_PATH_PATTERN.test(value) || UNC_PATH_PATTERN.test(value) || value.startsWith('/')) {
    return value;
  }

  return null;
};

export const pathToFileUri = (filepath: string): string => {
  if (/^file:\/\//i.test(filepath)) return filepath;

  if (UNC_PATH_PATTERN.test(filepath)) {
    return encodeURI(`file:${filepath.replace(/\\/g, '/')}`);
  }

  if (WINDOWS_ABSOLUTE_PATH_PATTERN.test(filepath)) {
    return encodeURI(`file:///${filepath.replace(/\\/g, '/')}`);
  }

  return encodeURI(`file://${filepath}`);
};
