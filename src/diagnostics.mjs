export const RESPONSE_LIMIT = 4000;
export function responseMessage(response) {
  let value = response?.bodyText;
  if (typeof value !== "string" && response?.body !== undefined) value = JSON.stringify(response.body);
  if (typeof value !== "string" && response?.data !== undefined)
    value = typeof response.data === "string" ? response.data : JSON.stringify(response.data);
  if (typeof value === "string" && value.length)
    return value.length > RESPONSE_LIMIT ? value.slice(0, RESPONSE_LIMIT) + "\n…" : value;
  const status = response?.statusCode ?? response?.status;
  return Number.isInteger(status) ? `HTTP ${status}` : "";
}
export function exceptionMessage(error) {
  const response = responseMessage(error?.response);
  if (response) return response;
  const code = typeof error?.code === "string" ? error.code : "";
  const message = typeof error?.message === "string" ? error.message
    : typeof error === "string" ? error : "Unknown error";
  return [code,message].filter(Boolean).join(": ").slice(0,RESPONSE_LIMIT);
}
