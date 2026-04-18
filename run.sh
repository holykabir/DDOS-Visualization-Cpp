#!/bin/bash

echo "Starting backend..."
cd backend/build
./threatscope &

sleep 2

echo "Starting frontend..."
cd ../../frontend
python3 -m http.server 8000 &

sleep 2

explorer.exe http://localhost:8000

