export type Row = { id: string; number: string; info: string; carrier?: string; phone?: string; state?: 'success' | 'error' | 'loading'; error?: string };
export type OutputKey = 'summary' | 'trackingNumber' | 'carrierName' | 'carrierCode' | 'status' | 'latest' | 'queriedAt' | 'trace' | 'syncLog';
export type Mapping = { number: string; info: string; carrier?: string; phone?: string; trigger?: string[]; outputs?: Partial<Record<OutputKey, string>> };
export type Field = { id: string; name: string; type: number };
export type QueryResult = {
  number: string;
  carrier: string;
  carrierCode?: string;
  state?: string;
  summary: string;
  mock: boolean;
  cached?: boolean;
  queriedAt: string;
  events: { time: string; content: string; status?: string; location?: string }[];
};
