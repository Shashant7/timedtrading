#!/bin/bash
# ML Model Backfill - Train on 14 days of historical data
# This script triggers the worker to label and train on past data

API_BASE="${API_BASE:-https://timed-trading-ingest.shashant.workers.dev}"
API_KEY="${TIMED_API_KEY}"

if [ -z "$API_KEY" ]; then
  echo "❌ Error: TIMED_API_KEY environment variable not set"
  echo "Usage: TIMED_API_KEY=your_key ./scripts/ml-backfill.sh"
  exit 1
fi

echo "🤖 ML Model Backfill"
echo "===================="
echo ""
echo "This will train the model on up to 14 days of historical data."
echo "It may take several minutes depending on data volume."
echo ""
echo "Triggering backfill training..."

# Call the training function multiple times to process queue in batches
# Each call processes up to 75 samples
for i in {1..20}; do
  echo ""
  echo "📊 Batch $i/20..."
  
  RESPONSE=$(curl -s -X POST \
    "${API_BASE}/timed/ml/train?key=${API_KEY}&limit=75" \
    -H "Content-Type: application/json")
  
  TRAINED=$(echo "$RESPONSE" | grep -o '"trained":[0-9]*' | cut -d':' -f2)
  MODEL_N=$(echo "$RESPONSE" | grep -o '"model_n":[0-9]*' | cut -d':' -f2)
  
  if [ -n "$TRAINED" ]; then
    echo "✅ Trained on $TRAINED examples (model total: $MODEL_N)"
    
    # If we trained fewer than 75, we're done
    if [ "$TRAINED" -lt 75 ]; then
      echo ""
      echo "🎉 Backfill complete! No more labeled data in queue."
      echo "Model has been trained on $MODEL_N total examples."
      break
    fi
  else
    echo "⚠️  No data trained in this batch"
    break
  fi
  
  # Small delay to avoid overwhelming the worker
  sleep 1
done

echo ""
echo "✅ Backfill training complete!"
echo ""
echo "Next steps:"
echo "1. Check logs: wrangler tail --env production"
echo "2. Verify model is working: Check UI for ML predictions"
echo "3. Monitor win rate over next few days"
