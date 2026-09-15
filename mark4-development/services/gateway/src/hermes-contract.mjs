export function unwrapList(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.sessions)) return value.sessions;
  if (Array.isArray(value?.messages)) return value.messages;
  if (Array.isArray(value?.items)) return value.items;
  return [];
}

export function unwrapSession(value) {
  if (value && typeof value === "object" && value.session && typeof value.session === "object") return value.session;
  return value && typeof value === "object" ? value : {};
}
