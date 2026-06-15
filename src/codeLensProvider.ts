import * as vscode from 'vscode';
import { ICommentStorage } from './storage';
import { GitService } from './gitService';

export class FCTCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChangeCodeLenses: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;

  constructor(private storage: ICommentStorage, private gitService: GitService) {}

  public refresh(): void {
    this._onDidChangeCodeLenses.fire();
  }

  public async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    if (document.uri.scheme !== 'file') return [];

    const repoId = this.gitService.getRepoId(document.uri);
    const filePath = this.gitService.getRelativePath(document.uri);
    
    const threads = await this.storage.loadThreadsByFile(repoId, filePath);
    const activeThreads = threads.filter(t => t.status === 'active');
    
    if (activeThreads.length === 0) return [];

    const lenses: vscode.CodeLens[] = [];
    
    // We get the symbols in the document
    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      'vscode.executeDocumentSymbolProvider',
      document.uri
    );

    if (!symbols) return [];

    // Recursively process symbols
    const processSymbols = (syms: vscode.DocumentSymbol[]) => {
      for (const symbol of syms) {
        // Only attach to Classes, Methods, Functions
        if (
          symbol.kind === vscode.SymbolKind.Class ||
          symbol.kind === vscode.SymbolKind.Method ||
          symbol.kind === vscode.SymbolKind.Function
        ) {
          // Count active threads within this symbol's range
          let count = 0;
          for (const t of activeThreads) {
            // We use currentStartLine which is 1-indexed
            const threadLine = t.currentStartLine - 1;
            if (threadLine >= symbol.range.start.line && threadLine <= symbol.range.end.line) {
              count++;
            }
          }

          if (count > 0) {
            // Find the first active thread inside this symbol's range
            const firstThread = activeThreads.find(t => {
              const threadLine = t.currentStartLine - 1;
              return threadLine >= symbol.range.start.line && threadLine <= symbol.range.end.line;
            });

            const lens = new vscode.CodeLens(symbol.range);
            lens.command = {
              title: `💬 ${count} Active Comment${count === 1 ? '' : 's'}`,
              tooltip: 'Click to jump to the first comment in this block',
              command: firstThread ? 'fct.revealComment' : '',
              arguments: firstThread ? [firstThread] : []
            };
            lenses.push(lens);
          }
        }
        
        if (symbol.children && symbol.children.length > 0) {
          processSymbols(symbol.children);
        }
      }
    };

    processSymbols(symbols);

    return lenses;
  }
}
