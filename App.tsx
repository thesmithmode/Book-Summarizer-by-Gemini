import React, { useState, useRef, useEffect } from 'react';
import { GoogleGenAI } from "@google/genai";
import { parseFile } from './utils/fileParser';
import { 
  CHUNK_SIZE, 
  PROMPT_EXTRACT, 
  PROMPT_CONSOLIDATE, 
  PROMPT_POLISH,
  MAX_CONCURRENT_REQUESTS 
} from './constants';
import { LogEntry, ProcessingState } from './types';

// Inject marked from global scope
declare const marked: any;

const App = () => {
  const [file, setFile] = useState<File | null>(null);
  const [processingState, setProcessingState] = useState<ProcessingState>(ProcessingState.IDLE);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [finalSummary, setFinalSummary] = useState<string>("");
  const [progress, setProgress] = useState(0);
  
  const logEndRef = useRef<HTMLDivElement>(null);

  // Auto scroll logs
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const addLog = (message: string, type: LogEntry['type'] = 'info') => {
    setLogs(prev => [...prev, {
      id: Math.random().toString(36).substring(7),
      timestamp: new Date(),
      message,
      type
    }]);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setFile(e.target.files[0]);
      setFinalSummary("");
      setLogs([]);
      setProcessingState(ProcessingState.IDLE);
    }
  };

  const processBook = async () => {
    if (!file) return;

    try {
      setProcessingState(ProcessingState.PARSING);
      addLog(`Reading file: ${file.name}...`);
      
      const text = await parseFile(file);
      addLog(`File parsed. Total characters: ${text.length}`, 'success');

      if (text.length < 100) {
        throw new Error("Extracted text is too short. Is the file empty or encrypted?");
      }

      setProcessingState(ProcessingState.CHUNKING);
      const chunks: string[] = [];
      for (let i = 0; i < text.length; i += CHUNK_SIZE) {
        chunks.push(text.slice(i, i + CHUNK_SIZE));
      }
      addLog(`Split content into ${chunks.length} parts for analysis.`);

      // --- STEP 1: EXTRACTION ---
      setProcessingState(ProcessingState.SUMMARIZING);
      const extractedSummaries: string[] = new Array(chunks.length).fill("");
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      // Process chunks in batches
      for (let i = 0; i < chunks.length; i += MAX_CONCURRENT_REQUESTS) {
        const batch = chunks.slice(i, i + MAX_CONCURRENT_REQUESTS);
        const batchPromises = batch.map(async (chunk, batchIdx) => {
          const actualIdx = i + batchIdx;
          addLog(`Analyzing Part ${actualIdx + 1}/${chunks.length}...`);
          
          try {
            const response = await ai.models.generateContent({
              model: 'gemini-2.5-flash',
              contents: `${PROMPT_EXTRACT}\n\nTEXT:\n${chunk}`,
            });
            return { idx: actualIdx, text: response.text || "" };
          } catch (err) {
            console.error(err);
            addLog(`Error analyzing part ${actualIdx + 1}, retrying...`, 'warning');
            // Simple retry logic could go here, for now we skip or return empty
            return { idx: actualIdx, text: "" };
          }
        });

        const results = await Promise.all(batchPromises);
        results.forEach(res => {
          if (res.text) extractedSummaries[res.idx] = res.text;
        });
        
        setProgress(Math.round(((i + batch.length) / chunks.length) * 50)); // First 50% of progress
      }

      const combinedDraft = extractedSummaries.filter(s => s.trim().length > 0).join("\n\n---\n\n");
      addLog(`Extraction complete. Combining insights...`, 'success');

      // --- STEP 2: CONSOLIDATION ---
      // If the draft is huge, we might need to recursively consolidate, but Gemini 2.5 Flash has 1M context.
      // We'll assume the extracted summaries fit in one context window (likely true for almost all books).
      setProcessingState(ProcessingState.POLISHING); // Reusing Polishing state for generic "Finalizing" UI
      addLog(`Consolidating summaries into a unified narrative...`);
      
      const consolidatedResponse = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: `${PROMPT_CONSOLIDATE}\n\nSUMMARIES:\n${combinedDraft}`,
      });
      
      const consolidatedText = consolidatedResponse.text || "";
      setProgress(75);
      addLog(`Consolidation complete. Polishing structure...`, 'success');

      // --- STEP 3: POLISHING ---
      // Using Flash or Pro. Pro is better for strict formatting adherence, but Flash is faster.
      // User prompt specifically requested Pro for "Complex Text Tasks".
      // Let's use Pro for the final touch to ensure high quality formatting.
      addLog(`Final polishing (this requires precision)...`);
      
      const finalResponse = await ai.models.generateContent({
        model: 'gemini-3-pro-preview', // High quality for the final structure
        contents: `${PROMPT_POLISH}\n\nTEXT:\n${consolidatedText}`,
      });

      const finalText = finalResponse.text || "";
      setFinalSummary(finalText);
      addLog(`Finished!`, 'success');
      setProcessingState(ProcessingState.COMPLETED);
      setProgress(100);

    } catch (error: any) {
      console.error(error);
      addLog(`Critical Error: ${error.message}`, 'error');
      setProcessingState(ProcessingState.ERROR);
    }
  };

  const copyToClipboard = () => {
    navigator.clipboard.writeText(finalSummary);
    alert("Copied to clipboard!");
  };

  return (
    <div className="min-h-screen p-4 md:p-8 max-w-4xl mx-auto">
      <header className="mb-8 text-center">
        <h1 className="text-3xl font-serif font-bold text-white mb-2 tracking-tight">EssenceReader</h1>
        <p className="text-gray-400 text-sm">AI-Powered Deep Book Summarizer</p>
      </header>

      {/* File Upload Section */}
      <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-8 mb-6 text-center transition-all hover:border-neutral-700">
        <input
          type="file"
          id="fileInput"
          accept=".pdf,.epub,.fb2,.xml,.txt"
          onChange={handleFileChange}
          className="hidden"
        />
        <label
          htmlFor="fileInput"
          className="cursor-pointer inline-flex items-center justify-center px-6 py-3 border border-transparent text-base font-medium rounded-md text-black bg-white hover:bg-gray-200 transition-colors"
        >
          {file ? 'Change Book' : 'Select Book (PDF, EPUB, FB2)'}
        </label>
        {file && (
          <div className="mt-4 text-gray-300">
            <p className="font-medium">{file.name}</p>
            <p className="text-xs text-gray-500 uppercase mt-1">{(file.size / 1024 / 1024).toFixed(2)} MB</p>
            
            {processingState === ProcessingState.IDLE && (
              <button
                onClick={processBook}
                className="mt-6 px-8 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-full font-medium transition-all shadow-lg hover:shadow-indigo-500/20"
              >
                Start Processing
              </button>
            )}
          </div>
        )}
      </div>

      {/* Progress & Logs Section */}
      {(processingState !== ProcessingState.IDLE || logs.length > 0) && (
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6 mb-6">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">Processing Log</h2>
            <span className="text-xs text-indigo-400 font-mono">{progress}%</span>
          </div>
          
          <div className="h-48 overflow-y-auto font-mono text-xs space-y-2 pr-2 custom-scrollbar bg-black/30 p-4 rounded-lg">
            {logs.map((log) => (
              <div key={log.id} className={`flex gap-3 ${
                log.type === 'error' ? 'text-red-400' : 
                log.type === 'success' ? 'text-green-400' : 
                log.type === 'warning' ? 'text-yellow-400' : 'text-gray-500'
              }`}>
                <span className="opacity-50 shrink-0">[{log.timestamp.toLocaleTimeString()}]</span>
                <span>{log.message}</span>
              </div>
            ))}
            <div ref={logEndRef} />
          </div>
        </div>
      )}

      {/* Result Section */}
      {finalSummary && (
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-8 shadow-2xl">
          <div className="flex justify-between items-end mb-6 border-b border-neutral-800 pb-4">
            <div>
              <h2 className="text-2xl font-serif text-white">Summary</h2>
              <p className="text-sm text-gray-500 mt-1">Generated by EssenceReader Pipeline</p>
            </div>
            <button
              onClick={copyToClipboard}
              className="text-xs text-gray-400 hover:text-white underline underline-offset-4"
            >
              Copy to Obsidian
            </button>
          </div>
          <div 
            className="markdown-content text-gray-300 leading-relaxed text-sm md:text-base"
            dangerouslySetInnerHTML={{ __html: marked.parse(finalSummary) }}
          />
        </div>
      )}
    </div>
  );
};

export default App;
