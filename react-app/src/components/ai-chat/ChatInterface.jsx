import React, { useState, useRef, useEffect } from 'react';

/**
 * AI Chat Interface Component
 * 
 * A chat interface for interacting with the AI trading assistant.
 * The AI can answer questions about tickers, analyze setups, and provide insights.
 */
export default function ChatInterface({ isOpen, onClose, tickerData, activityData }) {
  const [messages, setMessages] = useState([
    {
      role: 'assistant',
      content: '👋 Hi! I\'m your AI trading assistant. I can help you analyze tickers, understand setups, and provide insights. What would you like to know?',
      timestamp: new Date()
    }
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  const API_BASE = "";  // same-origin — proxied by Pages Function

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen]);

  const handleSend = async (e) => {
    e.preventDefault();
    if (!input.trim() || loading) return;

    const userMessage = {
      role: 'user',
      content: input.trim(),
      timestamp: new Date()
    };

    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setLoading(true);

    try {
      const response = await fetch(`${API_BASE}/timed/ai/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: userMessage.content,
          conversationHistory: messages.slice(-10), // Last 10 messages for context
          tickerData: tickerData ? Object.keys(tickerData).slice(0, 50) : [], // Sample ticker list
          activityData: activityData ? activityData.slice(0, 20) : [] // Recent activity
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      
      const assistantMessage = {
        role: 'assistant',
        content: data.response || 'Sorry, I couldn\'t process that request.',
        timestamp: new Date(),
        sources: data.sources || []
      };

      setMessages(prev => [...prev, assistantMessage]);
    } catch (error) {
      console.error('Chat error:', error);
      const errorMessage = {
        role: 'assistant',
        content: '❌ Sorry, I encountered an error. Please try again.',
        timestamp: new Date(),
        error: true
      };
      setMessages(prev => [...prev, errorMessage]);
    } finally {
      setLoading(false);
    }
  };

  const formatMessage = (content) => {
    // Simple markdown-like formatting
    return content
      .split('\n')
      .map((line, i) => {
        // Bold
        line = line.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        // Code blocks
        line = line.replace(/`(.+?)`/g, '<code class="bg-[#26325f] px-1 py-0.5 rounded text-xs">$1</code>');
        // Links
        line = line.replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" target="_blank" class="text-blue-400 hover:underline">$1</a>');
        return <p key={i} dangerouslySetInnerHTML={{ __html: line }} />;
      });
  };

  if (!isOpen) return null;

  return (
    <div className="fixed right-0 top-0 h-full w-96 bg-[#0f1630] border-l border-[#26325f] flex flex-col shadow-2xl z-50">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-[#26325f] bg-[#121a33]">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-purple-500 flex items-center justify-center text-white font-bold">
            AI
          </div>
          <div>
            <h3 className="text-sm font-semibold text-white">Trading Assistant</h3>
            <p className="text-xs text-[#93a4d6]">Powered by AI</p>
          </div>
        </div>
        <button
          onClick={onClose}
          className="text-[#93a4d6] hover:text-white transition-colors text-xl leading-none w-6 h-6 flex items-center justify-center rounded hover:bg-[#26325f]"
        >
          ✕
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map((msg, idx) => (
          <div
            key={idx}
            className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[80%] rounded-lg p-3 ${
                msg.role === 'user'
                  ? 'bg-blue-500/20 border border-blue-500/30 text-white'
                  : msg.error
                  ? 'bg-red-500/20 border border-red-500/30 text-red-300'
                  : 'bg-[#121a33] border border-[#26325f] text-[#e7ecff]'
              }`}
            >
              <div className="text-sm whitespace-pre-wrap">
                {formatMessage(msg.content)}
              </div>
              {msg.sources && msg.sources.length > 0 && (
                <div className="mt-2 pt-2 border-t border-[#26325f]">
                  <p className="text-xs text-[#93a4d6] mb-1">Sources:</p>
                  <ul className="text-xs text-[#93a4d6] space-y-1">
                    {msg.sources.map((source, i) => (
                      <li key={i}>• {source}</li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="text-xs text-[#6b7a9f] mt-1">
                {new Date(msg.timestamp).toLocaleTimeString()}
              </div>
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex justify-start">
            <div className="bg-[#121a33] border border-[#26325f] rounded-lg p-3">
              <div className="flex items-center gap-2 text-[#93a4d6] text-sm">
                <div className="w-2 h-2 bg-[#93a4d6] rounded-full animate-pulse"></div>
                <div className="w-2 h-2 bg-[#93a4d6] rounded-full animate-pulse" style={{ animationDelay: '0.2s' }}></div>
                <div className="w-2 h-2 bg-[#93a4d6] rounded-full animate-pulse" style={{ animationDelay: '0.4s' }}></div>
                <span>Thinking...</span>
              </div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <form onSubmit={handleSend} className="p-4 border-t border-[#26325f] bg-[#121a33]">
        <div className="flex gap-2">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about tickers, setups, or market conditions..."
            className="flex-1 px-4 py-2 bg-[#0f1630] border border-[#26325f] rounded-lg text-white placeholder-[#93a4d6] focus:outline-none focus:border-[#3a4aa0]"
            disabled={loading}
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            className="px-4 py-2 bg-blue-500 hover:bg-blue-600 disabled:bg-[#26325f] disabled:text-[#6b7a9f] rounded-lg text-white font-semibold transition-colors disabled:cursor-not-allowed"
          >
            Send
          </button>
        </div>
        <p className="text-xs text-[#6b7a9f] mt-2">
          💡 Try: "What's the status of AAPL?" or "Show me prime setups"
        </p>
      </form>
    </div>
  );
}

