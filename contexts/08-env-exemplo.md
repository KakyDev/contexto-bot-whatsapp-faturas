# 08 — .env.example

```env
NODE_ENV=development

# WhatsApp
WHATSAPP_CONTACT_NAME="CEEE Grupo Equatorial"
WHATSAPP_WEB_URL="https://web.whatsapp.com"
BROWSER_PROFILE_DIR="./.browser-profile"
HEADLESS=false

# Bot behavior
BOT_ACTION_DELAY_MS=5000
BOT_STEP_TIMEOUT_MS=60000
PDF_DOWNLOAD_TIMEOUT_MS=120000
MAX_RETRIES=2

# Files
INPUT_FILE="./data/entrada.xlsx"
OUTPUT_RESULTS_FILE="./output/resultados.csv"
OUTPUT_INVOICES_DIR="./output/invoices"
OUTPUT_ERROR_SCREENSHOTS_DIR="./output/errors/screenshots"

# Conversation
DEFAULT_INITIAL_MESSAGE="Olá"
DEFAULT_RATING="5"

# Debug
SAVE_SCREENSHOT_ON_SUCCESS=false
LOG_LEVEL=info
```

