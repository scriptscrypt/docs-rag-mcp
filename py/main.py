# reranker.py
from flask import Flask, request, jsonify
from sentence_transformers import CrossEncoder
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

model = CrossEncoder("jinaai/jina-reranker-v2-base-multilingual",trust_remote_code=True)

@app.route("/health")
def health():
    return jsonify(status="OK"), 200

@app.route("/rerank", methods=["POST"])
def rerank():
    data = request.json
    query = data["query"]
    docs = data["docs"]
    pairs = [(query, d) for d in docs]
    scores = model.predict(pairs)
    return jsonify(scores=scores.tolist())

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5005)
