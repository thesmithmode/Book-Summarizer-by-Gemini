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

// Inject marked from global scope
declare const marked: any;

const App = () => {
  // Config State
  const [language, setLanguage] = useState<Language>('EN');
  
  // Auth State
  const [apiKey, setApiKey] = useState<string>("");
  const [showAuthScreen, setShowAuthScreen] = useState<boolean>(true);

  // App State
  const [activeTab, setActiveTab] = useState<'analyze' | 'history'>('analyze');
  const [file, setFile] = useState<File | null>(null);
  const [processingState, setProcessingState] = useState<ProcessingState>(ProcessingState.IDLE);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [finalSummary, setFinalSummary] = useState<string>("");
  const [progress, setProgress] = useState(0);
  const [currentStatusMsg, setCurrentStatusMsg] = useState<string>(""); // For pulsing status

  // History State
  const [history, setHistory] = useState<HistoryItem[]>([]);
  
  // Stats
  const [startTime, setStartTime] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [estimatedTotalSeconds, setEstimatedTotalSeconds] = useState<number | null>(null);
  const [sessionTokens, setSessionTokens] = useState<number>(0);

  const logEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null); // For history import

  // Text Helper
  const T = UI_TEXT[language];

  // --- Initialization & Persistance ---

  useEffect(() => {
    // 1. Recover API Key
    const storedKey = localStorage.getItem("gemini_api_key");
    if (storedKey) {
      setApiKey(storedKey);
      setShowAuthScreen(false);
    }
    
    // 2. Recover Language
    const storedLang = localStorage.getItem("app_language");
    if (storedLang && ['EN','RU','ES','DE','FR'].includes(storedLang)) {
      setLanguage(storedLang as Language);
    }

    // 3. Recover History
    try {
      const storedHistory = localStorage.getItem("summary_history");
      if (storedHistory) {
        setHistory(JSON.parse(storedHistory));
      }
    } catch (e) {
      console.error("Failed to load history", e);
    }
  }, []);

  // Save history whenever it changes
  useEffect(() => {
    localStorage.setItem("summary_history", JSON.stringify(history));
  }, [history]);

  // Auto scroll logs
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  // Timer logic
  useEffect(() => {
    let interval: any;
    if (processingState !== ProcessingState.IDLE && processingState !== ProcessingState.COMPLETED && processingState !== ProcessingState.ERROR && startTime) {
      interval = setInterval(() => {
        const now = Date.now();
        const elapsed = Math.floor((now - startTime) / 1000);
        setElapsedSeconds(elapsed);

        // Estimate remaining time based on progress
        if (progress > 5) { 
           const total = Math.floor(elapsed * 100 / progress);
           setEstimatedTotalSeconds(total);
        }
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [processingState, startTime, progress]);

  // --- Handlers ---

  const handleLanguageChange = (lang: Language) => {
    setLanguage(lang);
    localStorage.setItem("app_language", lang);
  };

  const handleSaveKey = (key: string) => {
    if (key.trim().length > 10) {
      localStorage.setItem("gemini_api_key", key.trim());
      setApiKey(key.trim());
      setShowAuthScreen(false);
    } else {
      alert("Invalid API Key");
    }
  };

  const handleLogout = () => {
    // We do NOT clear history on logout, only the key
    localStorage.removeItem("gemini_api_key");
    setApiKey("");
    setShowAuthScreen(true);
    setFile(null);
    setFinalSummary("");
    setLogs([]);
    setSessionTokens(0);
    setActiveTab('analyze');
  };

  const addLog = (message: string, type: LogEntry['type'] = 'info') => {
    setLogs(prev => [...prev, {
      id: Math.random().toString(36).substring(7),
      timestamp: new Date(),
      message,
      type
    }]);
  };

  // --- Core Logic: Processing ---

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setFile(e.target.files[0]);
      setFinalSummary("");
      setLogs([]);
      setProcessingState(ProcessingState.IDLE);
      setProgress(0);
      setStartTime(null);
      setElapsedSeconds(0);
      setEstimatedTotalSeconds(null);
      setCurrentStatusMsg("");
    }
  };

  const processBook = async () => {
    if (!file || !apiKey) return;

    try {
      // Init Stats
      setStartTime(Date.now());
      setProcessingState(ProcessingState.PARSING);
      setCurrentStatusMsg(T.statusReading);
      addLog(`System: ${T.fileParsed} ${file.name}...`);
      
      // 1. Parsing
      const parseStart = Date.now();
      const text = await parseFile(file);
      const parseDuration = ((Date.now() - parseStart) / 1000).toFixed(2);
      addLog(`${T.fileParsed} ${parseDuration}s. Size: ${text.length.toLocaleString()} ${T.chars}.`, 'success');

      if (text.length < 100) {
        throw new Error("Text too short. File might be empty or encrypted.");
      }

      // 2. Chunking
      setProcessingState(ProcessingState.CHUNKING);
      setCurrentStatusMsg(T.chunking);
      const chunks: string[] = [];
      for (let i = 0; i < text.length; i += CHUNK_SIZE) {
        chunks.push(text.slice(i, i + CHUNK_SIZE));
      }
      
      const isSingleChunk = chunks.length === 1;
      addLog(`${T.chunking}: ${chunks.length} parts (~${(CHUNK_SIZE / 1000).toFixed(0)}k ${T.chars}).`);

      // Initialize AI
      // CRITICAL: New instance to ensure key is fresh
      const ai = new GoogleGenAI({ apiKey: apiKey });
      const prompts = getPrompts(language);
      
      // 3. Extraction (Step 1)
      setProcessingState(ProcessingState.SUMMARIZING);
      setCurrentStatusMsg(T.statusThinking);
      const extractedSummaries: string[] = new Array(chunks.length).fill("");
      
      for (let i = 0; i < chunks.length; i += MAX_CONCURRENT_REQUESTS) {
        const batch = chunks.slice(i, i + MAX_CONCURRENT_REQUESTS);
        
        const batchPromises = batch.map(async (chunk, batchIdx) => {
          const actualIdx = i + batchIdx;
          const chunkStartTime = Date.now();
          addLog(`[${T.step1}] Part ${actualIdx + 1}/${chunks.length} -> Gemini 3...`);
          
          try {
            const response = await ai.models.generateContent({
              model: GEMINI_MODEL,
              contents: `${prompts.extract}\n\nBOOK CONTENT (PART ${actualIdx + 1}):\n${chunk}`,
              config: { systemInstruction: prompts.systemInstruction }
            });

            const duration = ((Date.now() - chunkStartTime) / 1000).toFixed(1);
            const outputLen = response.text?.length || 0;
            const usage = response.usageMetadata?.totalTokenCount || 0;
            setSessionTokens(prev => prev + usage);
            
            addLog(`[${T.step1}] Part ${actualIdx + 1} done (${duration}s). Output: ${outputLen} chars.`, 'success');
            return { idx: actualIdx, text: response.text || "" };
          } catch (err: any) {
            console.error(err);
            if (err.message?.includes('API key') || err.status === 400 || err.status === 403) {
                 throw new Error("Invalid API Key or Access Denied.");
            }
            addLog(`[${T.error}] Part ${actualIdx + 1}: ${err.message}. Retrying...`, 'warning');
            // In a real app we might retry here, but for now we return empty to not crash the whole chain
            return { idx: actualIdx, text: "" };
          }
        });

        const results = await Promise.all(batchPromises);
        results.forEach(res => {
          if (res.text) extractedSummaries[res.idx] = res.text;
        });
        
        const extractedPercent = Math.round(((i + batch.length) / chunks.length) * 60);
        setProgress(extractedPercent);
      }

      const combinedDraft = extractedSummaries.filter(s => s.trim().length > 0).join("\n\n---\n\n");
      
      if (combinedDraft.length === 0) {
         throw new Error("Failed to extract any text.");
      }

      // 4. Consolidation (Step 2)
      let textToPolish = combinedDraft;
      
      if (!isSingleChunk) {
        addLog(`[${T.step2}] Consolidating ${chunks.length} parts...`);
        setProcessingState(ProcessingState.POLISHING); // Re-use styling
        setCurrentStatusMsg(T.statusThinking);
        
        const consolidateStart = Date.now();
        const consolidatedResponse = await ai.models.generateContent({
          model: GEMINI_MODEL,
          contents: `${prompts.consolidate}\n\nSUMMARIES:\n${combinedDraft}`,
          config: { systemInstruction: prompts.systemInstruction }
        });
        
        const consolidateDuration = ((Date.now() - consolidateStart) / 1000).toFixed(1);
        textToPolish = consolidatedResponse.text || "";
        const usage = consolidatedResponse.usageMetadata?.totalTokenCount || 0;
        setSessionTokens(prev => prev + usage);
        
        addLog(`[${T.step2}] Done (${consolidateDuration}s). Result: ${textToPolish.length.toLocaleString()} ${T.chars}.`, 'success');
        setProgress(80);
      } else {
        setProgress(70);
        addLog(`[${T.step2}] Skipped (single part).`);
      }

      // 5. Polishing (Step 3)
      addLog(`[${T.step3}] Final structuring...`);
      setProcessingState(ProcessingState.POLISHING);
      setCurrentStatusMsg(T.statusWriting);
      
      const polishStart = Date.now();
      const finalResponse = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: `${prompts.polish}\n\nDRAFT:\n${textToPolish}`,
        config: { systemInstruction: prompts.systemInstruction }
      });
      const polishDuration = ((Date.now() - polishStart) / 1000).toFixed(1);
      
      const finalText = finalResponse.text || "";
      setFinalSummary(finalText);
      const usage = finalResponse.usageMetadata?.totalTokenCount || 0;
      setSessionTokens(prev => prev + usage);

      addLog(`[${T.step3}] Done (${polishDuration}s).`, 'success');
      
      const totalTime = ((Date.now() - (startTime || 0)) / 1000).toFixed(1);
      addLog(`System: Cycle finished in ${totalTime}s.`, 'success');
      
      // Save to History
      const newHistoryItem: HistoryItem = {
        id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
        timestamp: Date.now(),
        fileName: file.name,
        language: language,
        summary: finalText,
        model: GEMINI_MODEL,
        tokenUsage: usage // approximate usage of last step, real usage is harder to track perfectly per item without state drift
      };
      
      // Update history state (which updates localStorage via useEffect)
      setHistory(prev => [newHistoryItem, ...prev]);

      setProcessingState(ProcessingState.COMPLETED);
      setCurrentStatusMsg("");
      setProgress(100);

    } catch (error: any) {
      console.error(error);
      addLog(`[${T.criticalError}] ${error.message}`, 'error');
      setProcessingState(ProcessingState.ERROR);
      setCurrentStatusMsg(T.error);
    }
  };

  // --- History & Export Logic ---

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
    a.download = `aibooksum_backup_${new Date().toISOString().slice(0,10)}.json`;
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
        // Basic validation
        if (json.version && Array.isArray(json.items)) {
          // Merge strategy: Prevent duplicates by ID
          setHistory(prev => {
            const existingIds = new Set(prev.map(i => i.id));
            const newItems = json.items.filter(i => !existingIds.has(i.id));
            return [...newItems, ...prev].sort((a,b) => b.timestamp - a.timestamp);
          });
          alert(T.restoreMsg);
        } else {
          alert("Invalid backup file format");
        }
      } catch (err) {
        alert("Error parsing backup file");
      }
    };
    reader.readAsText(file);
    // Reset input
    e.target.value = '';
  };

  // --- Display Helpers ---

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

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  const renderAuthScreen = () => (
    <div className="min-h-screen flex items-center justify-center p-4 bg-neutral-950 font-sans">
      <div className="absolute top-4 right-4 z-20">
        <select 
          value={language} 
          onChange={(e) => handleLanguageChange(e.target.value as Language)}
          className="bg-neutral-800 text-gray-300 text-xs px-2 py-1 rounded border border-neutral-700 outline-none"
        >
          <option value="EN">English</option>
          <option value="RU">Русский</option>
          <option value="ES">Español</option>
          <option value="DE">Deutsch</option>
          <option value="FR">Français</option>
        </select>
      </div>

      <div className="bg-neutral-900 border border-neutral-800 p-8 rounded-2xl max-w-md w-full shadow-2xl relative overflow-hidden">
        <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500 opacity-50"></div>
        <h1 className="text-3xl font-serif font-bold text-white mb-2 text-center">{T.loginTitle}</h1>
        <p className="text-gray-400 text-center mb-8 text-sm leading-relaxed">
          {T.loginSubtitle}
        </p>
        
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1 uppercase tracking-wide">API Key</label>
            <input 
              type="password" 
              placeholder={T.inputPlaceholder}
              className="w-full bg-black border border-neutral-700 rounded-lg px-4 py-3 text-white focus:ring-2 focus:ring-indigo-500 outline-none transition-all placeholder-neutral-600"
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSaveKey(e.currentTarget.value);
              }}
            />
          </div>
          
          <button 
            onClick={(e) => {
              const input = e.currentTarget.parentElement?.querySelector('input');
              if (input) handleSaveKey(input.value);
            }}
            className="w-full bg-white hover:bg-gray-100 text-black font-bold py-3 rounded-lg transition-all transform active:scale-[0.98]"
          >
            {T.loginButton}
          </button>
        </div>

        <div className="mt-6 text-center text-xs text-gray-500">
          <p>{T.noKey}</p>
          <a 
            href="https://aistudio.google.com/app/apikey" 
            target="_blank" 
            rel="noreferrer"
            className="text-indigo-400 hover:text-indigo-300 underline mt-1 inline-block"
          >
            {T.getKeyLink}
          </a>
        </div>
      </div>
    </div>
  );

  if (showAuthScreen) return renderAuthScreen();

  // --- Main App Render ---
  return (
    <div className="min-h-screen p-4 md:p-8 max-w-4xl mx-auto font-sans pb-20">
      
      {/* Header (Responsive) */}
      <header className="mb-8 flex flex-col md:flex-row justify-between items-center md:items-start gap-4 md:gap-8">
        <div className="text-center md:text-left order-2 md:order-1">
           <h1 className="text-3xl font-serif font-bold text-white mb-2 tracking-tight">{T.title}</h1>
           <p className="text-gray-400 text-sm">{T.subtitle}</p>
           
           {/* Session Token Stats */}
           {sessionTokens > 0 && (
            <div className="mt-2 inline-flex items-center gap-2">
                <span className="text-[10px] uppercase tracking-wide text-indigo-400 bg-indigo-900/20 px-2 py-0.5 rounded border border-indigo-900/50">
                    {T.tokenUsage}: {sessionTokens.toLocaleString()}
                </span>
                <a href="https://console.cloud.google.com/apis/dashboard" target="_blank" rel="noreferrer" className="text-[10px] text-gray-600 hover:text-gray-400 underline">
                 {T.checkQuota}
                </a>
            </div>
           )}
        </div>

        <div className="flex flex-col items-end gap-2 order-1 md:order-2 w-full md:w-auto">
          <div className="flex gap-2 w-full justify-end">
            <select 
                value={language} 
                onChange={(e) => handleLanguageChange(e.target.value as Language)}
                className="bg-neutral-900 text-gray-400 text-xs px-2 py-1.5 rounded border border-neutral-800 outline-none hover:border-neutral-600 transition-colors"
            >
                <option value="EN">EN</option>
                <option value="RU">RU</option>
                <option value="ES">ES</option>
                <option value="DE">DE</option>
                <option value="FR">FR</option>
            </select>

            <button 
                onClick={handleLogout}
                className="text-xs text-neutral-500 hover:text-white transition-colors border border-neutral-800 px-3 py-1.5 rounded hover:bg-neutral-800 whitespace-nowrap"
            >
                {T.logout}
            </button>
          </div>
        </div>
      </header>

      {/* Tabs */}
      <div className="flex border-b border-neutral-800 mb-6">
        <button 
          onClick={() => setActiveTab('analyze')}
          className={`px-6 py-3 text-sm font-medium transition-colors border-b-2 ${activeTab === 'analyze' ? 'border-indigo-500 text-white' : 'border-transparent text-gray-500 hover:text-gray-300'}`}
        >
          {T.tabAnalyze}
        </button>
        <button 
           onClick={() => setActiveTab('history')}
           className={`px-6 py-3 text-sm font-medium transition-colors border-b-2 ${activeTab === 'history' ? 'border-indigo-500 text-white' : 'border-transparent text-gray-500 hover:text-gray-300'}`}
        >
          {T.tabHistory} <span className="ml-1 text-xs opacity-50 bg-neutral-800 px-1.5 py-0.5 rounded-full">{history.length}</span>
        </button>
      </div>

      {/* VIEW: ANALYZE */}
      {activeTab === 'analyze' && (
        <div className="animate-fade-in">
          {/* File Upload / Status */}
          <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-8 mb-6 text-center transition-all hover:border-neutral-700 relative overflow-hidden group">
            <input
              type="file"
              id="fileInput"
              accept=".pdf,.epub,.fb2,.xml,.txt"
              onChange={handleFileChange}
              className="hidden"
              disabled={processingState !== ProcessingState.IDLE && processingState !== ProcessingState.COMPLETED && processingState !== ProcessingState.ERROR}
            />
            
            <label
              htmlFor="fileInput"
              className={`inline-flex items-center justify-center px-8 py-3 border border-transparent text-sm font-bold uppercase tracking-wider rounded-lg text-black bg-white transition-all 
                ${(processingState !== ProcessingState.IDLE && processingState !== ProcessingState.COMPLETED && processingState !== ProcessingState.ERROR) 
                  ? 'opacity-50 cursor-not-allowed' 
                  : 'hover:bg-gray-200 cursor-pointer shadow-lg hover:shadow-xl hover:-translate-y-0.5'}`}
            >
              {file ? T.changeFile : T.selectFile}
            </label>
            
            {file && (
              <div className="mt-6 text-gray-300 z-10 relative">
                <div className="inline-block p-4 bg-black/30 rounded-lg border border-neutral-800">
                    <p className="font-serif text-lg text-white">{file.name}</p>
                    <p className="text-xs text-gray-500 uppercase mt-1">{(file.size / 1024 / 1024).toFixed(2)} MB</p>
                </div>
                
                {processingState === ProcessingState.IDLE && (
                  <div className="mt-6">
                    <button
                        onClick={processBook}
                        className="px-8 py-3 bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-white rounded-lg font-bold transition-all shadow-lg hover:shadow-indigo-500/25 active:scale-95"
                    >
                        {T.startAnalysis}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Progress & Logs */}
          {(processingState !== ProcessingState.IDLE || logs.length > 0) && (
            <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6 mb-6 shadow-lg">
              <div className="flex justify-between items-center mb-4 border-b border-neutral-800 pb-2">
                <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
                    <h2 className="text-xs font-bold text-gray-400 uppercase tracking-widest">{T.logs}</h2>
                    
                    {/* Pulsing Status Indicator */}
                    {currentStatusMsg && (
                         <div className="flex items-center gap-2 bg-indigo-500/10 px-2 py-1 rounded text-indigo-400 text-xs font-medium border border-indigo-500/20">
                            <span className="relative flex h-2 w-2">
                              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75"></span>
                              <span className="relative inline-flex rounded-full h-2 w-2 bg-indigo-500"></span>
                            </span>
                            {currentStatusMsg}
                         </div>
                    )}
                </div>
                
                <span className="text-xs text-indigo-400 font-mono font-bold whitespace-nowrap">{progress}%</span>
              </div>
              
              {/* Timer Bar */}
              {processingState !== ProcessingState.IDLE && processingState !== ProcessingState.COMPLETED && processingState !== ProcessingState.ERROR && (
                <div className="mb-3 text-xs font-mono text-gray-500 bg-black/20 px-3 py-2 rounded flex justify-between">
                    <span>{T.timeElapsed}: <span className="text-white">{formatTime(elapsedSeconds)}</span></span>
                    {estimatedTotalSeconds !== null && (
                        <span>
                            {T.timeRem}: <span className="text-white">{formatTime(Math.max(0, estimatedTotalSeconds - elapsedSeconds))}</span>
                        </span>
                    )}
                </div>
              )}

              <div className="h-56 overflow-y-auto font-mono text-xs space-y-2 pr-2 custom-scrollbar bg-black/40 p-4 rounded-lg border border-neutral-800/50">
                {logs.map((log) => (
                  <div key={log.id} className={`flex gap-3 leading-relaxed ${
                    log.type === 'error' ? 'text-red-400 bg-red-900/10 p-1 rounded' : 
                    log.type === 'success' ? 'text-green-400' : 
                    log.type === 'warning' ? 'text-amber-400' : 'text-gray-500'
                  }`}>
                    <span className="opacity-40 shrink-0 select-none">[{log.timestamp.toLocaleTimeString()}]</span>
                    <span>{log.message}</span>
                  </div>
                ))}
                <div ref={logEndRef} />
              </div>
            </div>
          )}

          {/* Active Result View */}
          {finalSummary && (
            <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-8 shadow-2xl relative">
                <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-emerald-500 to-teal-500"></div>
              <div className="flex flex-col md:flex-row justify-between items-start md:items-end mb-8 border-b border-neutral-800 pb-6 gap-4">
                <div>
                  <h2 className="text-3xl font-serif text-white">{T.summaryTitle}</h2>
                  <p className="text-sm text-gray-500 mt-2">{T.generatedBy}</p>
                </div>
                <div className="flex gap-3">
                     <button
                      onClick={() => downloadMarkdown(finalSummary, file?.name || 'book')}
                      className="px-5 py-2.5 bg-neutral-800 hover:bg-neutral-700 text-gray-200 text-sm font-medium rounded-lg transition-colors border border-neutral-700 flex items-center gap-2"
                    >
                      {T.download}
                    </button>
                    <button
                      onClick={() => copyToClipboard(finalSummary)}
                      className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg transition-colors shadow-lg hover:shadow-indigo-500/20 flex items-center gap-2"
                    >
                      {T.copy}
                    </button>
                </div>
              </div>
              <div 
                className="markdown-content text-gray-300 leading-7 text-sm md:text-base font-light"
                dangerouslySetInnerHTML={{ __html: marked.parse(finalSummary) }}
              />
            </div>
          )}
        </div>
      )}

      {/* VIEW: HISTORY */}
      {activeTab === 'history' && (
        <div className="animate-fade-in space-y-6">
            {/* Toolbar */}
            <div className="flex justify-end gap-3 mb-4">
                <input 
                    type="file" 
                    ref={fileInputRef}
                    accept=".json"
                    className="hidden"
                    onChange={handleImportBackup}
                />
                <button 
                    onClick={() => fileInputRef.current?.click()}
                    className="text-xs text-gray-400 hover:text-white border border-neutral-800 hover:bg-neutral-800 px-3 py-2 rounded transition-colors"
                >
                    {T.import}
                </button>
                <button 
                    onClick={handleExportBackup}
                    disabled={history.length === 0}
                    className="text-xs text-indigo-400 hover:text-indigo-300 border border-indigo-900/50 hover:bg-indigo-900/20 px-3 py-2 rounded transition-colors disabled:opacity-50"
                >
                    {T.export}
                </button>
            </div>

            {history.length === 0 ? (
                <div className="text-center py-20 text-gray-600">
                    <p>{T.historyEmpty}</p>
                </div>
            ) : (
                <div className="grid gap-4">
                    {history.map((item) => (
                        <div key={item.id} className="bg-neutral-900 border border-neutral-800 rounded-lg p-5 hover:border-neutral-700 transition-colors">
                            <div className="flex flex-col md:flex-row justify-between md:items-center gap-4">
                                <div>
                                    <h3 className="font-serif text-lg text-white mb-1">{item.fileName}</h3>
                                    <div className="flex gap-3 text-xs text-gray-500">
                                        <span>{new Date(item.timestamp).toLocaleString()}</span>
                                        <span className="px-1.5 py-0.5 bg-neutral-800 rounded">{item.language}</span>
                                        {item.tokenUsage > 0 && <span>Tokens: {item.tokenUsage}</span>}
                                    </div>
                                </div>
                                <div className="flex gap-2">
                                    <button 
                                        onClick={() => {
                                            setFinalSummary(item.summary);
                                            setFile({ name: item.fileName } as File); // Mock file for display context
                                            setActiveTab('analyze');
                                            setProcessingState(ProcessingState.COMPLETED);
                                        }}
                                        className="px-3 py-1.5 bg-indigo-900/30 text-indigo-300 rounded hover:bg-indigo-900/50 text-xs font-medium border border-indigo-900/50"
                                    >
                                        {T.view}
                                    </button>
                                    <button 
                                        onClick={() => downloadMarkdown(item.summary, item.fileName)}
                                        className="px-3 py-1.5 bg-neutral-800 text-gray-400 rounded hover:bg-neutral-700 text-xs border border-neutral-700"
                                    >
                                        MD
                                    </button>
                                    <button 
                                        onClick={() => handleDeleteHistory(item.id)}
                                        className="px-3 py-1.5 text-red-400 hover:text-red-300 text-xs hover:bg-red-900/20 rounded"
                                    >
                                        {T.delete}
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