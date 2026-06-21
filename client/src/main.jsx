import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './PrecisionTraderPro.jsx';

class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(e) { return { error: e }; }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 40, background: '#06061a', color: '#ff4466', fontFamily: 'monospace', minHeight: '100vh' }}>
          <div style={{ fontSize: 18, marginBottom: 16, color: '#ff4466' }}>⚠ App Error</div>
          <pre style={{ fontSize: 12, color: '#ffcc00', whiteSpace: 'pre-wrap' }}>{String(this.state.error)}</pre>
          <pre style={{ fontSize: 11, color: '#555', whiteSpace: 'pre-wrap', marginTop: 12 }}>{this.state.error?.stack}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
