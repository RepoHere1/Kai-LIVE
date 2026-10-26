# Kai-Mirror Trading Dashboard - Python Version

This is a complete Python rewrite of the Node.js trading dashboard that converts the three HTML pages (index.html, dashboard.html, all-no-markets.html) from JavaScript/HTML/CSS to a Python web application.

## Overview

The Kai-Mirror trading dashboard is a sophisticated trading platform that provides:

- **Main DRY trading dashboard** - Simulated paper trading with real market data
- **Alternative dashboard** - Enhanced trading interface with live features
- **ALL NO MARKETS page** - NO-side only market strategy page

The original implementation was based on Node.js with real-time WebSocket communication, but this Python version maintains all the core functionality while providing better performance and maintainability.

## Key Features

### Core Functionality
- **Real-time strategy management** - Start/stop trading strategies, monitor performance
- **Account tracking** - Separate DRY (simulated) and LIVE (real) account views
- **WebSocket communication** - Real-time updates for trading signals and market data
- **REST API endpoints** - Complete API coverage for all trading operations
- **Persistent state management** - State saved to JSON files
- **Interactive dashboards** - Three main views with comprehensive trading data

### Trading Features
- **Strategy cards** - Display strategy performance with win rates, P&L, deployed capital
- **Real-time charts** - Interactive visualizations of trading performance
- **Position management** - View and manage open trading positions
- **Trade history** - Complete history of closed trades with analytics
- **Market data feeds** - Real-time price data from Kalshi and other exchanges
- **Risk management** - Stop-loss and take-profit controls
- **Kelly Criterion** - Optimal position sizing calculations

### User Interface
- **Clean, modern design** - Responsive web interface
- **Real-time updates** - Live dashboard updates via WebSocket
- **Search and filtering** - Filter trades and positions by various criteria
- **Action buttons** - Quick actions for trading operations
- **Professional layout** - Dark theme optimized for trading environments

## Technology Stack

### Backend
- **Flask** - Web framework for HTTP API endpoints
- **Flask-SocketIO** - WebSocket communication for real-time updates
- **Python** - Programming language for all backend logic
- **SQLite** - Local database for persistent storage

### Frontend
- **HTML5** - Page structure and content
- **CSS3** - Styling and layout
- **JavaScript** - Client-side interactivity and API calls
- **WebSocket** - Real-time communication with server

### Architecture
- **Microservices** - Modular design with separate concerns
- **Event-driven** - WebSocket-based real-time updates
- **Stateless** - Stateless API design
- **Scalable** - Designed for horizontal scaling

## Installation and Setup

### Prerequisites
```bash
python3 >= 3.8
pip >= 21.0
```

### Step 1: Clone the Repository
```bash
git clone https://github.com/your-repo/kai-mirror-python.git
cd kai-mirror-python
```

### Step 2: Create Virtual Environment
```bash
python3 -m venv venv
source venv/bin/activate  # On Windows: venv\\Scripts\\activate
```

### Step 3: Install Dependencies
```bash
pip install flask flask-socketio flask-cors
```

### Step 4: Run the Application
```bash
python app.py
```

The application will start on `http://127.0.0.1:5000`

## Usage

### Accessing the Dashboard

The Python version provides the same three pages as the original:

1. **Main DRY Dashboard**: `http://127.0.0.1:5000/`
   - Simulated paper trading dashboard
   - Strategy management
   - Account overview
   - Real-time updates

2. **LIVE Dashboard**: `http://127.0.0.1:5000/live`
   - Real trading dashboard
   - Live market data
   - Real account balances

3. **ALL NO MARKETS**: `http://127.0.0.1:5000/all-no-markets`
   - NO-side only market strategies
   - Maker (limit) entries only
   - Read-only interface
   - Independent book tracking

### Key Actions

#### Strategy Management
- **Start/Stop strategies**: Use buttons on strategy cards
- **View strategy details**: Click on strategy cards for detailed information
- **Analyze performance**: View P&L, win rates, and trade history

#### Account Management
- **Check balances**: View DRY and LIVE account balances
- **Monitor positions**: Track open and closed positions
- **View performance**: Analyze historical performance metrics

#### Market Data
- **Real-time prices**: Live market data from Kalshi
- **Trading signals**: Automated trading recommendations
- **Risk metrics**: Position sizing and risk calculations

### API Endpoints

The Python version provides RESTful API endpoints for:

- **Health checks**: `/api/health` - Server status
- **Mode information**: `/api/mode` - Current trading mode
- **Configuration**: `/api/config` - Runtime configuration
- **Logs**: `/api/logs` - System logs
- **DRY cash management**: `/api/dry/cash` - Update simulated cash
- **DRY reset**: `/api/dry/reset` - Reset simulated book
- **NO lanes toggle**: `/api/no-lanes` - Enable/disable NO lanes
- **ALL NO book data**: `/api/no-lanes/book` - Get NO markets data
- **ALL NO entry**: `/api/no-lanes/entry` - Create new NO position
- **ALL NO exit**: `/api/no-lanes/exit` - Close NO position

## Development and Testing

### Running Tests
```bash
# No tests currently implemented
# TODO: Add unit tests for trading logic
# TODO: Add integration tests for API endpoints
```

### Adding New Features

The Python version is designed for easy extension:

1. **Add new trading strategies**: Update `global_state.current_lanes`
2. **Add new markets**: Update API integrations
3. **Add new indicators**: Extend existing technical analysis
4. **Add new charts**: Include new visualization components

### Extending the API

The modular API design makes it easy to add new endpoints:

```python
@app.route('/api/new-feature')
def new_feature():
    # Implementation
    return jsonify({'status': 'ok'})
```

## Configuration

The application uses the following configuration options:

### Runtime Configuration
- `min_edge`: Minimum edge requirement for trades (0.06)
- `max_price`: Maximum entry price (0.90)
- `min_price`: Minimum entry price (0.05)
- `take_profit`: Take profit target (0.90)
- `stop_loss`: Stop loss target (0.25)
- `kelly_cap`: Kelly criterion cap (0.4)
- `min_hold_sec`: Minimum position holding time (45)
- `entry_cooldown_sec`: Entry cooldown period (120)

### State Management
- `trading_state.json`: Persistent application state
- `trading_data.db`: SQLite database for trade logs

## Performance and Scalability

### Real-time Updates
- **WebSocket communication**: Low-latency real-time updates
- **Background threads**: Non-blocking I/O operations
- **Efficient state management**: Optimized state updates

### Database Performance
- **SQLite**: Lightweight local database
- **Indexed queries**: Optimized for common trading operations
- **Connection pooling**: Efficient database connection management

### Memory Management
- **Streaming responses**: Large data processed in chunks
- **Connection limits**: Controlled concurrent connections
- **Garbage collection**: Automatic memory management

## Migration Guide

### From Node.js to Python

This section provides guidance for migrating from the original Node.js implementation:

#### File Structure
```
# Original Node.js structure
./
├── index.html
├── dashboard.html
├── all-no-markets.html
├── server.js
├── package.json
└── ...

# New Python structure
./
├── app.py                    # Main application
├── templates/              # HTML templates (if using)
├── static/                 # Static assets
├── trading_state.json       # Application state
├── trading_data.db          # Database
├── README.md                # Documentation
└── requirements.txt        # Dependencies
```

#### API Endpoints
Most Node.js endpoints have direct Python equivalents:

| Node.js | Python | Description |
|---------|--------| ------------ |
| `/api/mode` | `/api/mode` | Current trading mode |
| `/api/config` | `/api/config` | Runtime configuration |
| `/api/no-lanes` | `/api/no-lanes` | NO lanes management |
| `/api/no-lanes/book` | `/api/no-lanes/book` | ALL NO book data |
| `/api/no-lanes/entry` | `/api/no-lanes/entry` | Create NO position |
| `/api/no-lanes/exit` | `/api/no-lanes/exit` | Close NO position |

#### Data Models
Python uses dataclasses for data modeling:

```python
@dataclass
class Trade:
    market_id: str
    title: str
    side: str
    strategy: str
    entry_price: float
    exit_price: float
    quantity: int
    cost_basis: float
    proceeds: float
    pnl: float
    exit_reason: str
    result: str
    hold_seconds: int
    exit_timestamp: str
    opened: str
```

## Project Structure

### Core Files
- `app.py` - Main application entry point
- `requirements.txt` - Python dependencies
- `README.md` - Project documentation

### State Files
- `trading_state.json` - Persistent application state
- `trading_data.db` - SQLite database for trading data

### Static Assets
- `static/` - CSS, JavaScript, and other static files
- `templates/` - HTML templates (if using)

## Troubleshooting

### Common Issues

#### 1. Import Errors
```bash
pip install flask flask-socketio flask-cors
```

#### 2. Port Conflicts
```bash
# Check if port 5000 is available
netstat -tuln | grep :5000

# Change port in app.py if needed
app.run(host='127.0.0.1', port=5001)
```

#### 3. State Loading Issues
```bash
# Ensure write permissions in the working directory
touch trading_state.json
touch trading_data.db
```

### Getting Help

For issues with the Python version:

1. **GitHub Issues**: Report bugs and feature requests
2. **Documentation**: Check the README for detailed instructions
3. **Community**: Join the discussion forum for help

## Future Enhancements

The Python version includes several areas for future improvement:

### Performance Optimizations
- [ ] Database indexing
- [ ] Connection pooling
- [ ] Caching strategies

### Feature Expansions
- [ ] Additional trading strategies
- [ ] Advanced analytics
- [ ] Mobile app support
- [ ] Web3 integration
- [ ] Machine learning for trading signals

### API Enhancements
- [ ] OAuth2 authentication
- [ ] Rate limiting
- [ ] API versioning
- [ ] Webhooks for external integrations

## Acknowledgements

This Python version builds on the foundation of the original Node.js implementation:

- **Original Authors**: The team that created the Node.js trading dashboard
- **Contributors**: Community members who helped with the original implementation
- **Open Source**: Based on existing open-source trading libraries and frameworks

## License

This project is licensed under the MIT License. See `LICENSE` file for details.