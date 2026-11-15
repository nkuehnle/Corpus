import { http } from "../platform";

const BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";

let apiKey = "";
/** An NCBI API key raises the rate limit from 3 to 10 requests per second. */
export function setNcbiApiKey(key: string) {
  apiKey = key.trim();
}

// NCBI blocks clients that exceed the rate limit, so calls go out one at a time, spaced.
let last = Promise.resolve();
function throttled<T>(run: () => Promise<T>): Promise<T> {
  const gap = apiKey ? 110 : 350;
  const result = last.then(run);
  last = result.then(
    () => new Promise((r) => setTimeout(r, gap)),
    () => new Promise((r) => setTimeout(r, gap)),
  );
  return result;
}

export function eutils(endpoint: string, params: Record<string, string | number>): Promise<Response> {
  const q = new URLSearchParams({ tool: "corpus", ...params } as Record<string, string>);
  if (apiKey) q.set("api_key", apiKey);
  return throttled(() => http(`${BASE}/${endpoint}.fcgi?${q}`));
}

export async function eutilsJson<T>(endpoint: string, params: Record<string, string | number>): Promise<T> {
  return (await eutils(endpoint, { ...params, retmode: "json" })).json();
}
