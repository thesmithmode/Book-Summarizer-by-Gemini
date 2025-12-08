
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
  // Auth State
  const [apiKey, setApiKey] = useState<string>("");
  const [showAuthScreen, setShowAuthScreen] = useState<boolean>(true);

  // App State
  const [file, setFile] = useState<File | null>(null);
  const [processingState, setProcessingState] = useState<ProcessingState>(ProcessingState.IDLE);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [finalSummary, setFinalSummary] = useState<string>("");
  const [progress, setProgress] = useState(0);
  
  // Timing state
  const [startTime, setStartTime] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [estimatedTotalSeconds, setEstimatedTotalSeconds] = useState<number | null>(null);

  const logEndRef = useRef<HTMLDivElement>(null);

  // Check LocalStorage on load
  useEffect(() => {
    const storedKey = localStorage.getItem("gemini_api_key");
    if (storedKey) {
      setApiKey(storedKey);
      setShowAuthScreen(false);
    }
  }, []);

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

  const handleSaveKey = (key: string) => {
    if (key.trim().length > 10) {
      localStorage.setItem("gemini_api_key", key.trim());
      setApiKey(key.trim());
      setShowAuthScreen(false);
    } else {
      alert("Пожалуйста, введите корректный API ключ");
    }
  };

  const handleLogout = () => {
    localStorage.removeItem("gemini_api_key");
    setApiKey("");
    setShowAuthScreen(true);
    setFile(null);
    setFinalSummary("");
    setLogs([]);
  };

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

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
      setProgress(0);
      setStartTime(null);
      setElapsedSeconds(0);
      setEstimatedTotalSeconds(null);
    }
  };

  const processBook = async () => {
    if (!file || !apiKey) return;

    try {
      setStartTime(Date.now());
      setProcessingState(ProcessingState.PARSING);
      addLog(`[Система] Начало работы. Чтение файла: ${file.name}...`);
      
      const parseStart = Date.now();
      const text = await parseFile(file);
      const parseDuration = ((Date.now() - parseStart) / 1000).toFixed(2);
      addLog(`[Система] Файл прочитан за ${parseDuration}с. Объем: ${text.length.toLocaleString()} символов.`, 'success');

      if (text.length < 100) {
        throw new Error("Извлеченный текст слишком короткий. Возможно, файл пуст или зашифрован.");
      }

      setProcessingState(ProcessingState.CHUNKING);
      const chunks: string[] = [];
      for (let i = 0; i < text.length; i += CHUNK_SIZE) {
        chunks.push(text.slice(i, i + CHUNK_SIZE));
      }
      
      const isSingleChunk = chunks.length === 1;
      addLog(`[Система] Разбиение текста: ${chunks.length} ${chunks.length === 1 ? 'часть' : 'частей'} по ~${(CHUNK_SIZE / 1000).toFixed(0)}к символов.`);

      // --- STEP 1: EXTRACTION ---
      setProcessingState(ProcessingState.SUMMARIZING);
      const extractedSummaries: string[] = new Array(chunks.length).fill("");
      
      // Use the USER PROVIDED Key
      const ai = new GoogleGenAI({ apiKey: apiKey });
      const modelName = 'gemini-3-pro-preview';
      
      const systemInstruction = "Ты профессиональный литературный редактор. Твой язык вывода — СТРОГО РУССКИЙ (КИРИЛЛИЦА). Никогда не используй транслит. Никогда не отвечай на английском, если тебя не просили перевести.";

      for (let i = 0; i < chunks.length; i += MAX_CONCURRENT_REQUESTS) {
        const batch = chunks.slice(i, i + MAX_CONCURRENT_REQUESTS);
        
        const batchPromises = batch.map(async (chunk, batchIdx) => {
          const actualIdx = i + batchIdx;
          const chunkStartTime = Date.now();
          addLog(`[Этап 1: Извлечение] Часть ${actualIdx + 1}/${chunks.length} -> Отправка в Gemini 3 (${chunk.length.toLocaleString()} симв)...`);
          
          try {
            const response = await ai.models.generateContent({
              model: modelName,
              contents: `${PROMPT_EXTRACT}\n\nТЕКСТ КНИГИ (ЧАСТЬ ${actualIdx + 1}):\n${chunk}`,
              config: { systemInstruction }
            });

            const duration = ((Date.now() - chunkStartTime) / 1000).toFixed(1);
            const outputLen = response.text?.length || 0;
            const usage = response.usageMetadata;
            const tokens = usage?.totalTokenCount ? `${usage.totalTokenCount} токенов` : 'N/A';
            
            addLog(`[Этап 1: Извлечение] Часть ${actualIdx + 1} готова (${duration}с). Ответ: ${outputLen} симв. Расход: ${tokens}.`, 'success');
            return { idx: actualIdx, text: response.text || "" };
          } catch (err: any) {
            console.error(err);
            // Handle specific auth errors
            if (err.message.includes('API key') || err.status === 400 || err.status === 403) {
                 throw new Error("Неверный API ключ или доступ запрещен. Пожалуйста, проверьте ключ.");
            }
            addLog(`[Ошибка] Сбой при анализе части ${actualIdx + 1}: ${err.message}. Повторная попытка...`, 'warning');
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
         throw new Error("Не удалось извлечь информацию ни из одной части книги.");
      }

      addLog(`[Этап 1] Завершен. Общий объем черновика: ${combinedDraft.length.toLocaleString()} символов.`, 'success');

      // --- STEP 2: CONSOLIDATION ---
      let textToPolish = combinedDraft;
      
      if (!isSingleChunk) {
        addLog(`[Этап 2: Консолидация] Объединение ${chunks.length} частей в единый связный текст...`);
        setProcessingState(ProcessingState.POLISHING);
        
        const consolidateStart = Date.now();
        const consolidatedResponse = await ai.models.generateContent({
          model: modelName,
          contents: `${PROMPT_CONSOLIDATE}\n\nСАММАРИ ЧАСТЕЙ:\n${combinedDraft}`,
          config: { systemInstruction }
        });
        
        const consolidateDuration = ((Date.now() - consolidateStart) / 1000).toFixed(1);
        textToPolish = consolidatedResponse.text || "";
        const usage = consolidatedResponse.usageMetadata;
        
        addLog(`[Этап 2] Консолидация завершена (${consolidateDuration}с). Результат: ${textToPolish.length.toLocaleString()} симв. Токенов: ${usage?.totalTokenCount || '?'}`, 'success');
        setProgress(80);
      } else {
        setProgress(70);
        addLog(`[Этап 2] Пропущен (книга обработана одним запросом).`);
      }

      // --- STEP 3: POLISHING ---
      addLog(`[Этап 3: Шлифовка] Финальное структурирование для Obsidian...`);
      setProcessingState(ProcessingState.POLISHING);
      
      const polishStart = Date.now();
      const finalResponse = await ai.models.generateContent({
        model: modelName,
        contents: `${PROMPT_POLISH}\n\nЧЕРНОВОЙ ТЕКСТ:\n${textToPolish}`,
        config: { systemInstruction }
      });
      const polishDuration = ((Date.now() - polishStart) / 1000).toFixed(1);
      
      const finalText = finalResponse.text || "";
      setFinalSummary(finalText);
      const finalUsage = finalResponse.usageMetadata;

      addLog(`[Этап 3] Готово (${polishDuration}с). Финальный размер: ${finalText.length.toLocaleString()} симв. Токенов: ${finalUsage?.totalTokenCount || '?'}`, 'success');
      
      const totalTime = ((Date.now() - (startTime || 0)) / 1000).toFixed(1);
      addLog(`[Система] Полный цикл завершен за ${totalTime} секунд.`, 'success');
      
      setProcessingState(ProcessingState.COMPLETED);
      setProgress(100);

    } catch (error: any) {
      console.error(error);
      addLog(`[Критическая ошибка] ${error.message}`, 'error');
      setProcessingState(ProcessingState.ERROR);
    }
  };

  const copyToClipboard = () => {
    navigator.clipboard.writeText(finalSummary);
    addLog("[Интерфейс] Текст скопирован в буфер обмена.", 'info');
  };

  const downloadMarkdown = () => {
    const blob = new Blob([finalSummary], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `summary_${file?.name || 'book'}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    addLog("[Интерфейс] Файл Markdown скачан.", 'info');
  };

  // --- Auth Screen Component ---
  if (showAuthScreen) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-neutral-950">
        <div className="bg-neutral-900 border border-neutral-800 p-8 rounded-2xl max-w-md w-full shadow-2xl">
          <h1 className="text-3xl font-serif font-bold text-white mb-2 text-center">AI Book Summarizer</h1>
          <p className="text-gray-400 text-center mb-8 text-sm">
            Для работы приложения требуется ваш личный ключ Gemini API.
            Приложение работает полностью в браузере, ключ никуда не передается.
          </p>
          
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1 uppercase tracking-wide">Ваш API Key</label>
              <input 
                type="password" 
                placeholder="Вставьте AI Studio API Key..."
                className="w-full bg-black border border-neutral-700 rounded-lg px-4 py-3 text-white focus:ring-2 focus:ring-indigo-500 outline-none transition-all"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSaveKey(e.currentTarget.value);
                }}
                onChange={(e) => {
                  // If user pastes key, auto-focus button or validation could happen here
                }}
              />
            </div>
            
            <button 
              onClick={(e) => {
                const input = e.currentTarget.parentElement?.querySelector('input');
                if (input) handleSaveKey(input.value);
              }}
              className="w-full bg-white text-black font-semibold py-3 rounded-lg hover:bg-gray-200 transition-colors"
            >
              Войти
            </button>
          </div>

          <div className="mt-6 text-center text-xs text-gray-500">
            <p>Нет ключа?</p>
            <a 
              href="https://aistudiocdn.com/app/apikey" 
              target="_blank" 
              rel="noreferrer"
              className="text-indigo-400 hover:text-indigo-300 underline mt-1 inline-block"
            >
              Получить бесплатно в Google AI Studio
            </a>
          </div>
        </div>
      </div>
    );
  }

  // --- Main App UI ---
  return (
    <div className="min-h-screen p-4 md:p-8 max-w-4xl mx-auto">
      <header className="mb-8 flex flex-col items-center relative">
        <h1 className="text-3xl font-serif font-bold text-white mb-2 tracking-tight">AI Book Summarizer</h1>
        <p className="text-gray-400 text-sm">Глубокий анализ книг с помощью AI (Gemini 3)</p>
        
        <button 
          onClick={handleLogout}
          className="absolute right-0 top-0 text-xs text-neutral-600 hover:text-neutral-400 transition-colors border border-neutral-800 px-3 py-1 rounded hover:bg-neutral-800"
          title="Сменить API Ключ"
        >
          Выход
        </button>
      </header>

      {/* File Upload Section */}
      <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-8 mb-6 text-center transition-all hover:border-neutral-700 relative overflow-hidden">
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
          className={`inline-flex items-center justify-center px-6 py-3 border border-transparent text-base font-medium rounded-md text-black bg-white transition-all 
            ${(processingState !== ProcessingState.IDLE && processingState !== ProcessingState.COMPLETED && processingState !== ProcessingState.ERROR) 
              ? 'opacity-50 cursor-not-allowed' 
              : 'hover:bg-gray-200 cursor-pointer'}`}
        >
          {file ? 'Выбрать другую книгу' : 'Выберите книгу (PDF, EPUB, FB2)'}
        </label>
        
        {file && (
          <div className="mt-4 text-gray-300 z-10 relative">
            <p className="font-medium">{file.name}</p>
            <p className="text-xs text-gray-500 uppercase mt-1">{(file.size / 1024 / 1024).toFixed(2)} MB</p>
            
            {processingState === ProcessingState.IDLE && (
              <button
                onClick={processBook}
                className="mt-6 px-8 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-full font-medium transition-all shadow-lg hover:shadow-indigo-500/20"
              >
                Начать анализ
              </button>
            )}
          </div>
        )}
      </div>

      {/* Progress & Logs Section */}
      {(processingState !== ProcessingState.IDLE || logs.length > 0) && (
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6 mb-6">
          <div className="flex justify-between items-center mb-4">
            <div className="flex items-center gap-4">
                <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">Лог процесса</h2>
                {processingState !== ProcessingState.IDLE && processingState !== ProcessingState.COMPLETED && processingState !== ProcessingState.ERROR && (
                    <div className="text-xs font-mono text-gray-500 bg-neutral-800 px-2 py-1 rounded hidden sm:block">
                        <span>Прошло: <span className="text-white">{formatTime(elapsedSeconds)}</span></span>
                        {estimatedTotalSeconds !== null && (
                            <span className="ml-2 pl-2 border-l border-gray-600">
                                Ост: <span className="text-white">{formatTime(Math.max(0, estimatedTotalSeconds - elapsedSeconds))}</span>
                            </span>
                        )}
                    </div>
                )}
            </div>
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
          <div className="flex flex-col md:flex-row justify-between items-start md:items-end mb-6 border-b border-neutral-800 pb-4 gap-4">
            <div>
              <h2 className="text-2xl font-serif text-white">Резюме</h2>
              <p className="text-sm text-gray-500 mt-1">Сгенерировано AI Book Summarizer</p>
            </div>
            <div className="flex gap-3">
                 <button
                  onClick={downloadMarkdown}
                  className="px-4 py-2 bg-neutral-800 hover:bg-neutral-700 text-gray-200 text-sm rounded-lg transition-colors border border-neutral-700"
                >
                  Скачать .md
                </button>
                <button
                  onClick={copyToClipboard}
                  className="px-4 py-2 bg-indigo-900/50 hover:bg-indigo-800/50 text-indigo-200 text-sm rounded-lg transition-colors border border-indigo-800/50"
                >
                  Копировать
                </button>
            </div>
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
