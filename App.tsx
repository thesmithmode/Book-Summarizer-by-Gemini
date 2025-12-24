import React, { useState, useRef, useEffect } from 'react';
import { GoogleGenAI } from "@google/genai";
import { parseFile } from './utils/fileParser';
import { 
  CHUNK_SIZE, 
  MAX_CONCURRENT_REQUESTS,
  GEMINI_MODEL,
  UI_TEXT,
  getPrompts
} from './constants';
import { LogEntry, ProcessingState, Language, HistoryItem, BackupFile } from './types';

// Inject marked and DOMPurify from global scope
declare const marked: any;
declare const DOMPurify: any;

// --- Helper for smart text splitting ---
const smartSplitText = (text: string, maxSize: number): string[] => {
  const chunks: string[] = [];
  let startIndex = 0;

  while (startIndex < text.length) {
    // Ideally we want to cut at maxSize
    let endIndex = Math.min(startIndex + maxSize, text.length);

    // If we are not at the very end of text, try to find a sentence boundary
    if (endIndex < text.length) {
      // Look back up to 5% of chunk size or max 5000 chars to find punctuation
      const lookback = Math.min(5000, Math.floor(maxSize * 0.05));
      const searchBuffer = text.slice(endIndex - lookback, endIndex);
      
      // Find last occurrence of punctuation followed by space or newline
      // We look for: . ! ? or \n
      const lastPeriod = searchBuffer.lastIndexOf('.');
      const lastExcl = searchBuffer.lastIndexOf('!');
      const lastQ = searchBuffer.lastIndexOf('?');
      const lastNewline = searchBuffer.lastIndexOf('\n');

      const bestSplitRelative = Math.max(lastPeriod, lastExcl, lastQ, lastNewline);

      if (bestSplitRelative !== -1) {
        // If we found a split point, adjust endIndex
        // +1 because we want to include the punctuation mark in the current chunk
        endIndex = (endIndex - lookback) + bestSplitRelative + 1;
      }
    }

    const chunk = text.slice(startIndex, endIndex).trim();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }
    
    startIndex = endIndex;
  }
  
  return chunks;
};

// --- Custom Components ---

// 1. Custom Dropdown for Language
// Strictly styled to match the width and curvature of the button.
const LanguageDropdown = ({ 
    current, 
    onChange 
}: { 
    current: Language, 
    onChange: (l: Language) => void 
}) => {
    const [isOpen, setIsOpen] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);

    // Close on click outside
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const languages: Language[] = ['RU', 'EN', 'ES', 'DE', 'FR'];

    // Shared width class for perfect alignment
    const widthClass = "w-[90px]"; 

    return (
        <div className="relative h-full" ref={dropdownRef}>
            {/* Trigger Button Container - Increased border opacity to 20% */}
            <div className={`bg-[#212121] p-1 rounded-full border border-white/20 h-full flex items-center ${widthClass}`}>
                <button 
                    onClick={() => setIsOpen(!isOpen)}
                    className={`w-full h-full flex items-center justify-center gap-2 text-xs font-semibold rounded-full transition-all ${isOpen ? 'bg-[#2f2f2f] text-white' : 'text-gray-300 hover:text-white'}`}
                >
                    <span>{current}</span>
                    <svg 
                        className={`w-3 h-3 transition-transform duration-200 ${isOpen ? 'rotate-180 text-white' : 'text-gray-400'}`} 
                        fill="none" 
                        viewBox="0 0 24 24" 
                        stroke="currentColor"
                    >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                </button>
            </div>

            {/* Dropdown List - Increased border opacity to 20% */}
            {isOpen && (
                <div className={`absolute top-full right-0 mt-2 ${widthClass} bg-[#212121] border border-white/20 rounded-[24px] shadow-xl overflow-hidden z-50 flex flex-col p-1 animate-fade-in origin-top-right`}>
                    {languages.map((lang) => (
                        <button
                            key={lang}
                            onClick={() => {
                                onChange(lang);
                                setIsOpen(false);
                            }}
                            className={`text-center py-2.5 text-xs rounded-2xl transition-colors font-medium ${current === lang ? 'bg-[#2f2f2f] text-white' : 'text-gray-400 hover:bg-white/5 hover:text-gray-200'}`}
                        >
                            {lang}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
};

const App = () => {
  // Config State
  const [language, setLanguage] = useState<Language>('RU');
  const languageRef = useRef<Language>('RU');
  
  // App State
  const [activeTab, setActiveTab] = useState<'analyze' | 'history'>('analyze');
  const [file, setFile] = useState<File | null>(null);
  const [processingState, setProcessingState] = useState<ProcessingState>(ProcessingState.IDLE);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [finalSummary, setFinalSummary] = useState<string>("");
  const [progress, setProgress] = useState(0);
  const [currentStatusMsg, setCurrentStatusMsg] = useState<string>("");

  const currentDraftRef = useRef<string>("");
  const [history, setHistory] = useState<HistoryItem[]>([]);
  
  // --- Timer Stats ---
  const [startTime, setStartTime] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  // estimatedTotalDuration represents the predicted Total time from start to finish
  const [estimatedTotalDuration, setEstimatedTotalDuration] = useState<number | null>(null);
  const [sessionTokens, setSessionTokens] = useState<number>(0);
  
  const logEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const T = UI_TEXT[language];

  const isInteractionEnabled = processingState === ProcessingState.IDLE || 
                               processingState === ProcessingState.COMPLETED || 
                               processingState === ProcessingState.ERROR;

  // --- Initialization ---

  useEffect(() => {
    const storedLang = localStorage.getItem("app_language");
    if (storedLang && ['EN','RU','ES','DE','FR'].includes(storedLang)) {
      setLanguage(storedLang as Language);
      languageRef.current = storedLang as Language;
    }
    try {
      const storedHistory = localStorage.getItem("summary_history");
      if (storedHistory) {
        setHistory(JSON.parse(storedHistory));
      }
    } catch (e) {
      console.error("Failed to load history", e);
    }
  }, []);

  useEffect(() => {
    localStorage.setItem("summary_history", JSON.stringify(history));
  }, [history]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "auto" });
  }, [logs]);

  useEffect(() => {
    languageRef.current = language;
  }, [language]);

  // --- Timer Tick ---
  useEffect(() => {
    let interval: any;
    const isActive = processingState !== ProcessingState.IDLE && 
                     processingState !== ProcessingState.COMPLETED && 
                     processingState !== ProcessingState.ERROR;

    if (isActive && startTime) {
      interval = setInterval(() => {
        const now = Date.now();
        setElapsedSeconds(Math.floor((now - startTime) / 1000));
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [processingState, startTime]);

  // --- Handlers ---

  const handleLanguageChange = (lang: Language) => {
    setLanguage(lang);
    localStorage.setItem("app_language", lang);
  };

  const addLog = (message: string, type: LogEntry['type'] = 'info') => {
    setLogs(prev => [...prev, {
      id: Math.random().toString(36).substring(7),
      timestamp: new Date(),
      message,
      type
    }]);
  };

  const formatTime = (seconds: number) => {
    if (seconds < 0) seconds = 0;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  // --- Core Processing Logic ---

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setFile(e.target.files[0]);
      setFinalSummary("");
      setLogs([]);
      setProcessingState(ProcessingState.IDLE);
      setProgress(0);
      setStartTime(null);
      setElapsedSeconds(0);
      setEstimatedTotalDuration(null);
      setCurrentStatusMsg("");
      currentDraftRef.current = ""; 
    }
  };

  const processBook = async () => {
    if (!file) return;

    try {
      const startT = Date.now();
      setStartTime(startT);
      setProcessingState(ProcessingState.PARSING);
      setCurrentStatusMsg(T.statusReading);
      
      if (processingState === ProcessingState.ERROR) setLogs([]);
      
      addLog(`System: ${T.fileParsed} ${file.name}...`);
      currentDraftRef.current = "";
      
      const parseStart = Date.now();
      const text = await parseFile(file);
      const parseDuration = ((Date.now() - parseStart) / 1000).toFixed(2);
      addLog(`${T.fileParsed} ${parseDuration}s. Size: ${text.length.toLocaleString()} ${T.chars}.`, 'success');

      if (text.length < 100) throw new Error("Text too short.");

      // --- 1. Initial Calculation ---
      // Logic: 500k chars ~ 240 seconds (4 mins).
      // Rate: 240 / 500000 = 0.00048 sec/char.
      const initialEstimate = Math.ceil(text.length * 0.00048);
      // Ensure at least 30s for small files to avoid instant "00:00"
      setEstimatedTotalDuration(Math.max(30, initialEstimate));

      setProcessingState(ProcessingState.CHUNKING);
      setCurrentStatusMsg(T.chunking);
      
      const chunks = smartSplitText(text, CHUNK_SIZE);
      const totalChunks = chunks.length;
      
      addLog(`${T.chunking}: ${chunks.length} parts (Smart boundary detection enabled).`);

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      setProcessingState(ProcessingState.SUMMARIZING);
      setCurrentStatusMsg(T.statusThinking);
      const extractedSummaries: string[] = new Array(chunks.length).fill("");
      
      for (let i = 0; i < chunks.length; i += MAX_CONCURRENT_REQUESTS) {
        const batch = chunks.slice(i, i + MAX_CONCURRENT_REQUESTS);
        const batchPrompts = getPrompts(languageRef.current);

        const batchPromises = batch.map(async (chunk, batchIdx) => {
          const actualIdx = i + batchIdx;
          const chunkStartTime = Date.now();
          addLog(`[${T.step1}] Analyzing part ${actualIdx + 1}/${chunks.length}...`);
          
          try {
            const response = await ai.models.generateContent({
              model: GEMINI_MODEL,
              contents: `${batchPrompts.extract}\n\nCONTENT PART ${actualIdx + 1}:\n${chunk}`,
              config: { systemInstruction: batchPrompts.systemInstruction }
            });

            const duration = ((Date.now() - chunkStartTime) / 1000).toFixed(1);
            const outputText = response.text || "";
            const usage = response.usageMetadata?.totalTokenCount || 0;
            setSessionTokens(prev => prev + usage);
            
            addLog(`[${T.step1}] Part ${actualIdx + 1} extracted (${duration}s). Length: ${outputText.length}.`, 'success');
            return { idx: actualIdx, text: outputText };
          } catch (err: any) {
            console.error(err);
            addLog(`[${T.error}] Part ${actualIdx + 1}: ${err.message}`, 'warning');
            return { idx: actualIdx, text: "" };
          }
        });

        await Promise.all(batchPromises).then(results => {
           results.forEach(res => {
             if (res.text) extractedSummaries[res.idx] = res.text;
           });
        });
        
        // --- 2. Dynamic Update of Total Duration ---
        // Calculate average time per chunk so far (including parse time as overhead)
        const now = Date.now();
        const timeElapsedSoFar = (now - startT) / 1000;
        const chunksCompleted = i + batch.length;
        
        const avgTimePerChunk = timeElapsedSoFar / chunksCompleted;
        
        // Prediction: Elapsed + (Avg * RemainingChunks) + Fixed Overhead for Consolidation
        const chunksRemaining = totalChunks - chunksCompleted;
        const overheadForConsolidation = avgTimePerChunk * 1.5; // Roughly 1.5x chunk time for final polish
        
        const newTotalEstimate = Math.ceil(timeElapsedSoFar + (avgTimePerChunk * chunksRemaining) + overheadForConsolidation);
        
        setEstimatedTotalDuration(newTotalEstimate);
        
        currentDraftRef.current = extractedSummaries.filter(s => s.trim().length > 0).join("\n\n");
        const extractedPercent = Math.round(((i + batch.length) / chunks.length) * 60);
        setProgress(extractedPercent);
      }

      const combinedDraft = currentDraftRef.current;
      
      if (combinedDraft.length === 0) throw new Error("Failed to extract any text.");

      setProcessingState(ProcessingState.POLISHING);
      setCurrentStatusMsg(T.statusThinking);
      
      addLog(`[${T.step2}] Consolidating ${chunks.length} parts...`);
      const consolidateStart = Date.now();
      const consolidatePrompts = getPrompts(languageRef.current);

      const consolidatedResponse = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: `${consolidatePrompts.consolidate}\n\nEXTRACTED DRAFTS:\n${combinedDraft}`,
        config: { systemInstruction: consolidatePrompts.systemInstruction }
      });
      
      const consolidateDuration = ((Date.now() - consolidateStart) / 1000).toFixed(1);
      const consolidatedText = consolidatedResponse.text || "";
      const usageConsolidate = consolidatedResponse.usageMetadata?.totalTokenCount || 0;
      setSessionTokens(prev => prev + usageConsolidate);
      
      addLog(`[${T.step2}] Consolidation done (${consolidateDuration}s). Size: ${consolidatedText.length}.`, 'success');
      setProgress(80);

      addLog(`[${T.step3}] Final formatting...`);
      setCurrentStatusMsg(T.statusWriting);
      
      const polishStart = Date.now();
      const polishPrompts = getPrompts(languageRef.current);

      const finalResponse = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: `${polishPrompts.polish}\n\nTEXT TO POLISH:\n${consolidatedText}`,
        config: { systemInstruction: polishPrompts.systemInstruction }
      });
      
      const polishDuration = ((Date.now() - polishStart) / 1000).toFixed(1);
      const finalText = finalResponse.text || "";
      const usagePolish = finalResponse.usageMetadata?.totalTokenCount || 0;
      setSessionTokens(prev => prev + usagePolish);

      setFinalSummary(finalText);
      addLog(`[${T.step3}] Finished (${polishDuration}s).`, 'success');
      
      const newHistoryItem: HistoryItem = {
        id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
        timestamp: Date.now(),
        fileName: file.name,
        language: languageRef.current,
        summary: finalText,
        model: GEMINI_MODEL,
        tokenUsage: usagePolish
      };
      
      setHistory(prev => [newHistoryItem, ...prev]);
      setProcessingState(ProcessingState.COMPLETED);
      setCurrentStatusMsg("");
      setProgress(100);

    } catch (error: any) {
      console.error(error);
      
      if (currentDraftRef.current && currentDraftRef.current.length > 500) {
          addLog(`[${T.criticalError}] Pipeline failed, but partial data was recovered.`, 'warning');
          addLog("Displaying raw consolidated draft.", 'info');
          
          setFinalSummary(currentDraftRef.current);
          setProcessingState(ProcessingState.COMPLETED);
          setCurrentStatusMsg("Completed with Errors");
          
           const newHistoryItem: HistoryItem = {
            id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
            timestamp: Date.now(),
            fileName: file.name + " (PARTIAL)",
            language: languageRef.current,
            summary: currentDraftRef.current,
            model: GEMINI_MODEL,
            tokenUsage: sessionTokens
          };
          setHistory(prev => [newHistoryItem, ...prev]);
          
      } else {
          addLog(`[${T.criticalError}] ${error.message}`, 'error');
          setProcessingState(ProcessingState.ERROR);
          setCurrentStatusMsg(T.error);
      }
    }
  };

  // --- History Logic ---

  const handleDeleteHistory = (id: string) => {
    if (confirm(T.delete + "?")) {
      setHistory(prev => prev.filter(item => item.id !== id));
    }
  };

  const handleExportBackup = () => {
    const backup: BackupFile = {
      version: 1,
      createdAt: Date.now(),
      items: history
    };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `aibooksum_export_${new Date().toISOString().slice(0,10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleImportBackup = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const json = JSON.parse(event.target?.result as string) as BackupFile;
        if (json.version && Array.isArray(json.items)) {
          setHistory(prev => {
            const existingIds = new Set(prev.map(i => i.id));
            const newItems = json.items.filter(i => !existingIds.has(i.id));
            return [...newItems, ...prev].sort((a,b) => b.timestamp - a.timestamp);
          });
          alert(T.restoreMsg);
        } else {
          alert("Invalid JSON format");
        }
      } catch (err) {
        alert("Error parsing JSON");
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    addLog(T.copySuccess, 'info');
  };

  const downloadMarkdown = (content: string, filename: string) => {
    const blob = new Blob([content], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `summary_${filename}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // --- Render ---

  // Calculated Remaining for Display
  const remainingDisplay = estimatedTotalDuration !== null 
    ? Math.max(0, estimatedTotalDuration - elapsedSeconds) 
    : null;

  return (
    <div className="min-h-screen p-4 md:p-6 max-w-4xl mx-auto font-sans pb-20">
      
      {/* Header */}
      <header className="mb-8 flex flex-col md:flex-row justify-between items-center md:items-start gap-6">
        <div className="text-center md:text-left order-2 md:order-1">
           <h1 className="text-3xl font-serif font-bold text-white mb-2 tracking-tight">{T.title}</h1>
           <p className="text-[#9b9b9b] text-sm">{T.subtitle}</p>
        </div>

        <div className="flex items-center gap-3 order-1 md:order-2 h-10">
           {/* Tab Segmented Control */}
           <div className="bg-[#212121] p-1 rounded-full flex gap-1 items-center border border-white/20 h-full">
              <button 
                onClick={() => setActiveTab('analyze')}
                className={`px-4 py-1.5 text-xs font-semibold rounded-full transition-all h-full flex items-center ${activeTab === 'analyze' ? 'bg-[#2f2f2f] text-white border border-white/10' : 'text-gray-400 hover:text-gray-200 border border-transparent'}`}
              >
                {T.tabAnalyze}
              </button>
              <button 
                onClick={() => setActiveTab('history')}
                className={`px-4 py-1.5 text-xs font-semibold rounded-full transition-all h-full flex items-center ${activeTab === 'history' ? 'bg-[#2f2f2f] text-white border border-white/10' : 'text-gray-400 hover:text-gray-200 border border-transparent'}`}
              >
                {T.tabHistory} 
                {history.length > 0 && <span className="ml-1 opacity-70">({history.length})</span>}
              </button>
           </div>

           {/* Custom Language Dropdown */}
           <LanguageDropdown current={language} onChange={handleLanguageChange} />
        </div>
      </header>

      {/* Content Area */}
      {activeTab === 'analyze' && (
        <div className="animate-fade-in flex flex-col gap-6">
          
          {/* File Upload Area */}
          <div className="relative group">
             {/* Hidden File Input */}
             <input
                type="file"
                id="fileInput"
                accept=".zip,.pdf,.fb2,.xml,.txt,.md"
                onChange={handleFileChange}
                className="hidden"
                disabled={!isInteractionEnabled}
             />
             
             {/* Main Card UI */}
             <div className="bg-[#212121] rounded-[2rem] p-6 border border-white/20 transition-colors">
                
                {/* 1. STATE: NO FILE SELECTED (Big Clickable Area) */}
                {!file && (
                    <label 
                        htmlFor="fileInput" 
                        className="flex flex-col items-center justify-center gap-4 py-10 cursor-pointer hover:bg-[#262626] rounded-xl transition-colors w-full h-full"
                    >
                        <div className="bg-[#2f2f2f] rounded-full p-5 border border-white/10">
                            <svg className="w-8 h-8 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" />
                            </svg>
                        </div>
                        <div className="text-center">
                            <span className="text-gray-200 font-semibold text-lg">{T.selectFile}</span>
                            <p className="text-gray-500 text-xs mt-1">ZIP, PDF, FB2, TXT, MD</p>
                        </div>
                    </label>
                )}

                {/* 2. STATE: FILE SELECTED (File Info + Actions) */}
                {file && (
                    <div className="flex flex-col items-center gap-6 py-4 w-full">
                        {/* File Info */}
                        <div className="flex flex-col items-center">
                            <div className="w-12 h-12 bg-[#2f2f2f] rounded-full flex items-center justify-center border border-white/10 mb-3">
                                <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                </svg>
                            </div>
                            <p className="font-serif text-xl text-white text-center px-4 break-words max-w-full">{file.name}</p>
                            <p className="text-xs text-[#10a37f] font-mono mt-1 uppercase tracking-wider">{(file.size / 1024 / 1024).toFixed(2)} MB</p>
                        </div>

                        {/* Action Buttons: GRID for equal sizing */}
                        <div className="w-full max-w-md grid grid-cols-2 gap-3">
                            {/* Change File (Outline Style) */}
                            {isInteractionEnabled && (
                                <label 
                                    htmlFor="fileInput"
                                    className="flex items-center justify-center px-4 py-3 bg-transparent hover:bg-white/5 text-white rounded-full text-xs font-bold uppercase tracking-wider cursor-pointer border border-white/20 transition-all text-center leading-tight min-h-[56px] select-none"
                                >
                                    {T.changeFile}
                                </label>
                            )}

                            {/* Start Analysis (Primary Green) */}
                            {isInteractionEnabled && (
                                <button
                                    onClick={processBook}
                                    className="flex items-center justify-center px-4 py-3 bg-[#10a37f] hover:bg-[#0e906f] text-white rounded-full font-bold uppercase tracking-wider transition-all border border-transparent text-center leading-tight min-h-[56px] select-none shadow-md"
                                >
                                    <div className="flex items-center gap-2">
                                        <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                        </svg>
                                        <span>{processingState === ProcessingState.ERROR ? "RETRY" : T.startAnalysis}</span>
                                    </div>
                                </button>
                            )}

                             {/* Processing State */}
                             {(!isInteractionEnabled) && (
                                <div className="col-span-2 flex items-center justify-center px-8 py-3 bg-[#2f2f2f] text-gray-200 rounded-full font-medium border border-white/10 gap-3 min-h-[56px]">
                                    <div className="w-4 h-4 border-2 border-gray-500 border-t-white rounded-full animate-spin"></div>
                                    <span className="text-xs uppercase tracking-wider">{currentStatusMsg || T.statusThinking}</span>
                                </div>
                             )}
                        </div>
                    </div>
                )}
             </div>
          </div>

          {/* Progress & Logs - Dark container */}
          {(processingState !== ProcessingState.IDLE || logs.length > 0) && (
            <div className="bg-[#212121] border border-white/20 rounded-[2rem] p-6 shadow-sm">
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-4 border-b border-white/5 pb-2 gap-2">
                
                {/* Left Side: Title + Timers Group */}
                <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 w-full sm:w-auto">
                    <h2 className="text-xs font-bold text-gray-500 uppercase tracking-widest">{T.logs}</h2>
                    
                    {/* Unified Timers Group - Side by Side */}
                    {(processingState !== ProcessingState.IDLE) && (
                       <div className="flex items-center gap-3">
                          {/* Elapsed */}
                          <div className="text-[10px] font-mono text-gray-300 bg-[#2f2f2f] px-3 py-1.5 rounded-lg border border-white/10 flex items-center gap-2">
                             <div className={`w-1.5 h-1.5 rounded-full ${processingState === ProcessingState.COMPLETED ? 'bg-green-500' : 'bg-green-500 animate-pulse'}`}></div>
                             <span>{T.timeElapsed}: {formatTime(elapsedSeconds)}</span>
                          </div>
                          
                          {/* Remaining - Derived from TotalEstimate - Elapsed */}
                          {processingState !== ProcessingState.COMPLETED && (
                             <div className="text-[10px] font-mono text-gray-400 bg-[#2f2f2f] px-3 py-1.5 rounded-lg border border-white/10">
                                <span>{T.timeRem}: {remainingDisplay !== null ? formatTime(remainingDisplay) : "--:--"}</span>
                             </div>
                          )}
                       </div>
                    )}
                </div>
                
                {/* Right Side: Status + Progress */}
                <div className="flex items-center gap-3 w-full sm:w-auto justify-between sm:justify-end mt-2 sm:mt-0">
                    <div className="flex items-center gap-3">
                        {currentStatusMsg && (
                            <div className={`hidden sm:flex items-center gap-2 bg-black/30 px-3 py-1 rounded-full text-xs font-medium border ${processingState === ProcessingState.ERROR ? 'text-red-400 border-red-500/20' : 'text-green-400 border-green-500/20'}`}>
                                {processingState !== ProcessingState.ERROR && (
                                    <span className="relative flex h-2 w-2">
                                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                                        <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
                                    </span>
                                )}
                                <span className="truncate max-w-[150px]">{currentStatusMsg}</span>
                            </div>
                        )}
                        <span className="text-xs text-gray-400 font-mono font-bold whitespace-nowrap min-w-[35px] text-right">{progress}%</span>
                    </div>
                </div>
              </div>
              
              {/* Token Usage Stats */}
              {sessionTokens > 0 && (
                <div className="mb-4 flex items-center justify-between text-[10px] text-gray-600 px-1">
                   <span>TOKENS: {sessionTokens.toLocaleString()}</span>
                   {/* Mobile only status message */}
                   <span className="sm:hidden text-gray-500 truncate max-w-[200px]">{currentStatusMsg}</span>
                </div>
              )}

              <div className="h-48 overflow-y-auto font-mono text-xs space-y-2 pr-2 custom-scrollbar p-2">
                {logs.map((log) => (
                  <div key={log.id} className={`flex gap-3 leading-relaxed ${
                    log.type === 'error' ? 'text-red-400' : 
                    log.type === 'success' ? 'text-[#10a37f]' : 
                    log.type === 'warning' ? 'text-amber-400' : 'text-gray-500'
                  }`}>
                    <span className="opacity-30 shrink-0 select-none">[{log.timestamp.toLocaleTimeString().split(' ')[0]}]</span>
                    <span>{log.message}</span>
                  </div>
                ))}
                <div ref={logEndRef} />
              </div>
            </div>
          )}

          {/* Final Result */}
          {finalSummary && (
            <div className="bg-[#212121] border border-white/20 rounded-[2rem] p-8 relative">
              <div className="flex flex-col md:flex-row justify-between items-start md:items-end mb-8 border-b border-white/5 pb-6 gap-4">
                <div>
                  <h2 className="text-2xl font-serif text-white">{T.summaryTitle}</h2>
                  <p className="text-xs text-gray-600 mt-2 tracking-wide uppercase">{T.generatedBy}</p>
                </div>
                <div className="flex gap-2">
                     <button
                      onClick={() => downloadMarkdown(finalSummary, file?.name || 'book')}
                      className="px-4 py-2 bg-[#2f2f2f] hover:bg-[#3f3f3f] text-gray-200 text-xs font-bold uppercase rounded-full border border-white/20 transition-colors flex items-center gap-2"
                    >
                      MD
                    </button>
                    <button
                      onClick={() => copyToClipboard(finalSummary)}
                      className="px-4 py-2 bg-[#2f2f2f] hover:bg-[#3f3f3f] text-gray-200 text-xs font-bold uppercase rounded-full border border-white/20 transition-colors flex items-center gap-2"
                    >
                      {T.copy}
                    </button>
                </div>
              </div>
              <div 
                className="markdown-content text-gray-300 leading-7 text-sm md:text-base font-light"
                dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(marked.parse(finalSummary)) }}
              />
            </div>
          )}
        </div>
      )}

      {/* TAB: HISTORY */}
      {activeTab === 'history' && (
        <div className="animate-fade-in space-y-4">
            <div className="flex justify-end gap-2 mb-4">
                <input 
                    type="file" 
                    ref={fileInputRef}
                    accept=".json"
                    className="hidden"
                    onChange={handleImportBackup}
                />
                <button 
                    onClick={() => fileInputRef.current?.click()}
                    className="text-xs text-gray-400 hover:text-white bg-[#212121] hover:bg-[#2f2f2f] px-4 py-2 rounded-full border border-white/20 transition-colors"
                >
                    {T.import}
                </button>
                <button 
                    onClick={handleExportBackup}
                    disabled={history.length === 0}
                    className="text-xs text-gray-400 hover:text-white bg-[#212121] hover:bg-[#2f2f2f] px-4 py-2 rounded-full border border-white/20 transition-colors disabled:opacity-30"
                >
                    {T.export}
                </button>
            </div>

            {history.length === 0 ? (
                <div className="text-center py-20 text-gray-800">
                    <p>{T.historyEmpty}</p>
                </div>
            ) : (
                <div className="grid gap-3">
                    {history.map((item) => (
                        <div key={item.id} className="bg-[#212121] border border-white/20 rounded-3xl p-6 hover:bg-[#262626] transition-colors group">
                            <div className="flex flex-col md:flex-row justify-between md:items-center gap-4">
                                <div>
                                    <h3 className="font-serif text-lg text-white mb-1 group-hover:text-green-400 transition-colors">{item.fileName}</h3>
                                    <div className="flex gap-3 text-xs text-gray-600">
                                        <span>{new Date(item.timestamp).toLocaleString()}</span>
                                        <span className="px-2 py-0.5 bg-[#2f2f2f] rounded-full text-gray-400">{item.language}</span>
                                    </div>
                                </div>
                                <div className="flex gap-2">
                                    <button 
                                        onClick={() => {
                                            setFinalSummary(item.summary);
                                            setFile({ name: item.fileName } as File);
                                            setActiveTab('analyze');
                                            setProcessingState(ProcessingState.COMPLETED);
                                        }}
                                        className="px-4 py-2 bg-[#2f2f2f] hover:bg-[#10a37f] text-gray-300 hover:text-white rounded-full text-xs font-bold uppercase border border-white/20 transition-colors"
                                    >
                                        {T.view}
                                    </button>
                                    <button 
                                        onClick={() => handleDeleteHistory(item.id)}
                                        className="px-3 py-2 text-gray-600 hover:text-red-400 text-xs rounded-full border border-white/10 transition-colors"
                                    >
                                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                        </svg>
                                    </button>
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
      )}
    </div>
  );
};

export default App;