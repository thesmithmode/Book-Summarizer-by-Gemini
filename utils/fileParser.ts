declare const pdfjsLib: any;
declare const JSZip: any;

const stripTags = (text: string): string => {
  return text.replace(/<[^>]*>?/gm, ' ').replace(/\s+/g, ' ').trim();
};

export const parseFile = async (file: File): Promise<string> => {
  const fileType = file.name.split('.').pop()?.toLowerCase();
  
  try {
    if (fileType === 'pdf') {
      return await parsePDF(file);
    } else if (['fb2', 'xml'].includes(fileType || '')) {
      return await parseFB2(file);
    } else if (fileType === 'epub') {
      return await parseEPUB(file);
    } else {
      // Fallback for text files
      return await file.text();
    }
  } catch (error) {
    console.error("File parsing error:", error);
    throw new Error(`Failed to parse ${fileType?.toUpperCase()} file.`);
  }
};

const parsePDF = async (file: File): Promise<string> => {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  let fullText = '';

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = textContent.items.map((item: any) => item.str).join(' ');
    fullText += pageText + '\n\n';
  }
  return fullText;
};

const parseFB2 = async (file: File): Promise<string> => {
  const text = await file.text();
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(text, "text/xml");
  
  // FB2 usually puts the main text in <body>
  const bodies = xmlDoc.getElementsByTagName("body");
  let fullText = "";
  
  for (let i = 0; i < bodies.length; i++) {
    // Basic text extraction from nodes
    fullText += bodies[i].textContent || "";
  }
  
  return stripTags(fullText); // Cleanup extra whitespace
};

const parseEPUB = async (file: File): Promise<string> => {
  const zip = new JSZip();
  const content = await zip.loadAsync(file);
  let fullText = "";

  // 1. Find container.xml to locate the OPF
  // 2. Parse OPF to find the manifest and spine (order of reading)
  // Simplified approach: Iterate all .html/.xhtml files. 
  // A robust reader follows the spine, but for summarization, raw text dump is usually sufficient
  // provided we avoid typical navigation files.
  
  const files: {name: string, content: string}[] = [];
  
  for (const filename in content.files) {
    if (filename.match(/\.(xhtml|html|htm)$/i) && !filename.includes('nav') && !filename.includes('toc')) {
       const fileText = await content.files[filename].async("string");
       files.push({ name: filename, content: fileText });
    }
  }

  // Sort files strictly by name might be wrong for EPUBs, but often chapters are named 001.html, 002.html etc.
  // Ideally we parse the OPF, but for this snippet size, sorting by name is a reasonable heuristic for simple EPUBs.
  files.sort((a, b) => a.name.localeCompare(b.name));

  for (const f of files) {
    const doc = new DOMParser().parseFromString(f.content, "text/html");
    fullText += (doc.body.textContent || "") + "\n\n";
  }

  return stripTags(fullText);
};
