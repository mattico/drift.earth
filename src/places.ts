// Place search via Places API (New), called directly with fetch (no Maps JS SDK).
// Autocomplete + Details share a session token, which Google bills as one session.

export interface Suggestion {
  placeId: string;
  text: string;
  /** Short name, e.g. "Eiffel Tower" for "Eiffel Tower, Av. Gustave Eiffel, Paris". */
  name: string;
}

export class PlaceSearch {
  private session = crypto.randomUUID();

  constructor(private readonly apiKey: string) {}

  async suggest(input: string, signal?: AbortSignal): Promise<Suggestion[]> {
    const res = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': this.apiKey,
        'X-Goog-FieldMask':
          'suggestions.placePrediction.placeId,suggestions.placePrediction.text.text,suggestions.placePrediction.structuredFormat.mainText.text',
      },
      body: JSON.stringify({ input, sessionToken: this.session }),
    });
    if (!res.ok) throw new Error(await errorText(res));
    const json = (await res.json()) as {
      suggestions?: Array<{
        placePrediction?: { placeId: string; text: { text: string }; structuredFormat?: { mainText?: { text: string } } };
      }>;
    };
    return (json.suggestions ?? [])
      .map((s) => s.placePrediction)
      .filter((p): p is NonNullable<typeof p> => !!p)
      .map((p) => ({ placeId: p.placeId, text: p.text.text, name: p.structuredFormat?.mainText?.text ?? p.text.text }));
  }

  /** Location only: `location` is an Essentials field, so this stays on the cheapest Details SKU. */
  async locate(placeId: string): Promise<{ lat: number; lon: number }> {
    const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?sessionToken=${this.session}`;
    const res = await fetch(url, {
      headers: { 'X-Goog-Api-Key': this.apiKey, 'X-Goog-FieldMask': 'location' },
    });
    this.session = crypto.randomUUID();
    if (!res.ok) throw new Error(await errorText(res));
    const json = (await res.json()) as { location: { latitude: number; longitude: number } };
    return { lat: json.location.latitude, lon: json.location.longitude };
  }
}

async function errorText(res: Response): Promise<string> {
  if (res.status === 403) return 'Search needs Places API (New) enabled and allowed for this key.';
  try {
    const j = (await res.json()) as { error?: { message?: string } };
    return j.error?.message ?? `Search failed (${res.status})`;
  } catch {
    return `Search failed (${res.status})`;
  }
}
