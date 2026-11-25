import { http } from "../platform";

/** The best free copy of an article that Unpaywall knows of (publisher's free archive,
 *  author manuscript, repository), or '' when it knows of none. Unpaywall asks for an email
 *  address per request; a placeholder is sent rather than the user's. */
export async function freeCopy(doi: string): Promise<string> {
  try {
    const res = await http(`https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=unpaywall@corpus.invalid`);
    return (await res.json()).best_oa_location?.url ?? "";
  } catch (e) {
    // A DOI Unpaywall has never seen has no free copy it can point to.
    if (String(e).includes("answered 404")) return "";
    throw e;
  }
}
