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

/** Parameters as an object, or as pairs when a name repeats (elink takes one `id` per record). */
type Params = Record<string, string | number> | [string, string][];

export function eutils(endpoint: string, params: Params): Promise<Response> {
  const q = new URLSearchParams([
    ["tool", "corpus"],
    ...(Array.isArray(params) ? params : Object.entries(params).map(([k, v]): [string, string] => [k, String(v)])),
  ]);
  if (apiKey) q.set("api_key", apiKey);
  return throttled(() => http(`${BASE}/${endpoint}.fcgi?${q}`));
}

export async function eutilsJson<T>(endpoint: string, params: Params): Promise<T> {
  const withJson: Params = Array.isArray(params) ? [...params, ["retmode", "json"]] : { ...params, retmode: "json" };
  return (await eutils(endpoint, withJson)).json();
}
