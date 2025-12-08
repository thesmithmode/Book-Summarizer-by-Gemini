export enum ProcessingState {
  IDLE = 'IDLE',
  PARSING = 'PARSING',
  CHUNKING = 'CHUNKING',
  SUMMARIZING = 'SUMMARIZING',
  POLISHING = 'POLISHING',
  COMPLETED = 'COMPLETED',
  ERROR = 'ERROR'
}

export type Language = 'EN' | 'RU' | 'ES' | 'DE' | 'FR';

export interface LogEntry {
  id: string;
  timestamp: Date;
  message: string;
  type: 'info' | 'success' | 'warning' | 'error';
}

export interface SummaryPart {
  id: number;
  content: string;
  isComplete: boolean;
}

export interface ProcessedBook {
  fileName: string;
  finalSummary: string;
  rawSummaries: string[];
}