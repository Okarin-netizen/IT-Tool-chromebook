// localStorage can throw or be empty (private window, guest mode, blocked site data).
// The tools keep working without it; they just don't remember.

export function loadJson(key, fallback = null) {
  try {
    const value = localStorage.getItem(key);
    return value == null ? fallback : JSON.parse(value);
  } catch {
    return fallback;
  }
}

// Returns false when the value could not be stored.
export function saveJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

// Plain strings, for settings that were always stored without JSON.
export function loadText(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function saveText(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not remembered.
  }
}
