import * as vscode from 'vscode';
import { ICommentStorage } from './storage';

export async function exportActiveComments(storage: ICommentStorage, repoId: string) {
  const threads = await storage.loadAllThreads(repoId);
  const activeThreads = threads.filter(t => t.status === 'active');

  if (activeThreads.length === 0) {
    vscode.window.showInformationMessage('No active FCT comments found to export.');
    return;
  }

  // Group by file
  const fileMap = new Map<string, typeof activeThreads>();
  for (const t of activeThreads) {
    if (!fileMap.has(t.filePath)) {
      fileMap.set(t.filePath, []);
    }
    fileMap.get(t.filePath)!.push(t);
  }

  let markdown = `# Floating Comments Export\n\n`;
  markdown += `Generated on ${new Date().toLocaleString()}\n\n`;

  for (const [filePath, fileThreads] of fileMap.entries()) {
    markdown += `## 📄 ${filePath}\n\n`;

    for (const t of fileThreads) {
      const firstComment = t.comments[0];
      if (!firstComment) continue;

      let bodyStr = firstComment.body;

      // Render GitHub-style permalink pseudo-link
      const start = t.currentStartLine;
      const end = t.currentEndLine;
      const linesText = start === end ? `L${start}` : `L${start}-L${end}`;
      
      markdown += `### ${bodyStr.split('\n')[0].substring(0, 50)}...\n`;
      markdown += `- **Author**: ${firstComment.author}\n`;
      markdown += `- **Location**: \`${filePath}:${linesText}\`\n\n`;

      if (t.codeSnippet) {
        markdown += `\`\`\`typescript\n${t.codeSnippet}\n\`\`\`\n\n`;
      }

      markdown += `> ${bodyStr.replace(/\n/g, '\n> ')}\n\n`;
      
      if (t.comments.length > 1) {
        markdown += `**Replies:**\n`;
        for (let i = 1; i < t.comments.length; i++) {
          const c = t.comments[i];
          const cBody = c.body;
          markdown += `- **${c.author}**: ${cBody.replace(/\n/g, ' ')}\n`;
        }
        markdown += '\n';
      }

      markdown += `---\n\n`;
    }
  }

  await vscode.env.clipboard.writeText(markdown);
  
  // Show in a new editor
  const doc = await vscode.workspace.openTextDocument({
    content: markdown,
    language: 'markdown'
  });
  await vscode.window.showTextDocument(doc);
  
  vscode.window.showInformationMessage(`Exported ${activeThreads.length} active comments to clipboard.`);
}
