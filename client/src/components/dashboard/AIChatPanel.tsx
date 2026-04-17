import { useState, useEffect, useCallback, useRef } from "react";
import { trpc } from "@/lib/trpc";
import { MessageSquare, Send } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function AIChatPanel() {
  const [messages, setMessages] = useState<{role: 'user' | 'assistant'; content: string}[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const chatMutation = trpc.narration.chat.useMutation();

  const handleSend = useCallback(async () => {
    if (!input.trim() || isLoading) return;
    const userMsg = input.trim();
    setInput('');
    setMessages(prev => [...prev, { role: 'user', content: userMsg }]);
    setIsLoading(true);
    try {
      const result = await chatMutation.mutateAsync({ message: userMsg, history: messages.slice(-10) });
      setMessages(prev => [...prev, { role: 'assistant', content: result.reply }]);
    } catch {
      setMessages(prev => [...prev, { role: 'assistant', content: 'Error. Intenta de nuevo.' }]);
    } finally {
      setIsLoading(false);
    }
  }, [input, isLoading, messages, chatMutation]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  const quickQuestions = ['Que operar?', 'Estado GEX', 'Explicar vanna', 'UVIX-GLD'];

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <MessageSquare size={12} className="text-purple-400" />
        <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Chat IA</span>
        <Badge variant="outline" className="text-[8px] border-purple-500/30 text-purple-400 ml-auto">GPT-4.1</Badge>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-2 space-y-2 min-h-0">
        {messages.length === 0 && (
          <div className="text-center py-3">
            <MessageSquare size={20} className="mx-auto mb-1.5 text-purple-400/30" />
            <p className="text-[10px] text-muted-foreground mb-2">Pregunta sobre el mercado</p>
            <div className="flex flex-wrap gap-1 justify-center">
              {quickQuestions.map(q => (
                <button key={q} onClick={() => setInput(q)} className="text-[9px] px-2 py-0.5 rounded-full border border-purple-500/30 text-purple-400 hover:bg-purple-500/10 transition-colors">{q}</button>
              ))}
            </div>
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[85%] rounded-lg p-2 text-[10px] leading-relaxed ${
              msg.role === 'user' ? 'bg-purple-500/20 border border-purple-500/30 text-foreground' : 'bg-card border border-border text-foreground'
            }`}>
              <p className="whitespace-pre-line">{msg.content}</p>
            </div>
          </div>
        ))}
        {isLoading && (
          <div className="flex justify-start">
            <div className="bg-card border border-border rounded-lg p-2">
              <div className="flex items-center gap-1">
                <div className="w-1.5 h-1.5 bg-purple-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                <div className="w-1.5 h-1.5 bg-purple-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                <div className="w-1.5 h-1.5 bg-purple-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="p-2 border-t border-border">
        <div className="flex items-center gap-1.5">
          <Input value={input} onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
            placeholder="Pregunta..." className="text-[10px] h-7 bg-background border-border/50" disabled={isLoading} />
          <Button size="sm" variant="outline" onClick={handleSend} disabled={isLoading || !input.trim()} className="h-7 w-7 p-0 border-purple-500/30">
            <Send size={10} className="text-purple-400" />
          </Button>
        </div>
      </div>
    </div>
  );
}
