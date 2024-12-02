require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { MongoClient } = require("mongodb");
const config = require('./config');
const path = require('path');
const app = express();

app.use(express.json());
app.use(cors());

// Set the PORT from the config or default to 8082
const PORT = config.PORT || 8082;

// MongoDB Setup
const username = encodeURIComponent(config.MONGODB.USERNAME);
const password = encodeURIComponent(config.MONGODB.PASSWORD);
const clusterHost = config.MONGODB.CLUSTER_HOST;
const dbName = config.MONGODB.DB_NAME;
const uri = `mongodb+srv://${username}:${password}@${clusterHost}/?retryWrites=true&w=majority`;
const client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true });

const Sentiment = require('sentiment');
const sentiment = new Sentiment();
const natural = require('natural');
const tokenizer = new natural.WordTokenizer();
const NodeCache = require('node-cache');
const cache = new NodeCache({ stdTTL: 3600 }); // Cache for 1 hour
const cron = require('node-cron');
const CoinGecko = require('coingecko-api');
const CoinGeckoClient = new CoinGecko();

let db;
let guardianCollection;
let nytCollection;
let redditCollection;

// Connect to MongoDB
client.connect()
    .then(() => {
        console.log("Connected to MongoDB");
        db = client.db(dbName);
        guardianCollection = db.collection(config.MONGODB.COLLECTIONS.GUARDIAN);
        nytCollection = db.collection(config.MONGODB.COLLECTIONS.NYTIMES);
        redditCollection = db.collection(config.MONGODB.COLLECTIONS.REDDIT);
    })
    .catch(err => {
        console.error("MongoDB Connection Error:", err);
        process.exit();
    });

// Serve static files from the React frontend build directory
app.use(express.static(path.join(__dirname, 'build')));

// Fallback to serving index.html for unknown routes (React Router support)
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'build', 'index.html'));
});

// Helper functions and scheduled tasks (as per your original code)

// Function to extract hostname
function extractHostname(url) {
    if (!url) return 'Unknown';
    let hostname = url.includes("//") ? url.split('/')[2] : url.split('/')[0];
    hostname = hostname.split(':')[0].split('?')[0];
    const hostnameParts = hostname.split('.');
    return hostnameParts.length > 2 ? hostnameParts[hostnameParts.length - 2] : hostnameParts[0];
}

// Function to get Reddit Access Token
async function getRedditAccessToken() {
    const { TOKEN_URL, CLIENT_ID_SECRET, USERNAME, PASSWORD } = config.REDDIT;

    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('username', USERNAME);
    params.append('password', PASSWORD);

    try {
        const response = await axios.post(TOKEN_URL, params, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': `Basic ${CLIENT_ID_SECRET}`
            }
        });
        return response.data.access_token;
    } catch (error) {
        console.error('Error fetching Reddit access token:', error);
        throw new Error('Failed to fetch Reddit access token');
    }
}

// Function to analyze sentiment
function analyzeSentiment(text) {
    const result = sentiment.analyze(text || "");
    return result.score; // Positive score for positive sentiment, negative for negative sentiment
}

// Function to extract keywords from text
function extractKeywords(text) {
    const stopWords = ['the', 'is', 'in', 'and', 'of', 'to', 'a']; // Basic stop words list
    const tokens = tokenizer.tokenize(text.toLowerCase());
    return tokens.filter(word => word.length > 3 && !stopWords.includes(word));
}

// API Endpoints
// Add your existing endpoints (like /guardian, /nytimes, /reddit, /articles, /trending, etc.) below
// Example endpoint:
/**
 * The Guardian Business API - Fetches and stores articles from The Guardian
 */
app.get('/guardian', async (req, res) => {
    const API_KEY = 'c5be12ec-9f2f-4ba2-8e1c-ee89971ab1ed';
    const BASE_URL = 'https://content.guardianapis.com/search';
    const query = 'crypto';
    const pageSize = 200;

    try {
        // Fetch existing articles from MongoDB
        const existingArticles = await guardianCollection.find().toArray();

        // Fetch the first page to determine total pages
        const firstPageUrl = `${BASE_URL}?q=${query}&page-size=${pageSize}&page=1&api-key=${API_KEY}`;
        const firstPageResponse = await axios.get(firstPageUrl);
        const totalPages = firstPageResponse.data.response.pages;

        // Generate URLs for all pages
        const urls = [];
        for (let page = 1; page <= totalPages; page++) {
            const url = `${BASE_URL}?q=${query}&page-size=${pageSize}&page=${page}&api-key=${API_KEY}`;
            urls.push(url);
        }

        // Fetch all pages concurrently
        const fetchPagePromises = urls.map(url => axios.get(url));
        const responses = await Promise.all(fetchPagePromises);

        // Collect all articles from the responses
        const allArticles = responses.flatMap(response => response.data.response.results);

        // Map the articles to the required structure
        const newArticles = allArticles.map(article => ({
            publicationDate: article.webPublicationDate,
            title: article.webTitle,
            url: article.webUrl,
            source: extractHostname(article.webUrl)
        }));

        // Insert logic for inserting or updating articles in MongoDB as per your existing implementation
        // ...

        res.json(newArticles); // Example response
    } catch (error) {
        console.error("Error fetching Guardian articles:", error);
        res.status(500).json({ message: 'Error fetching Guardian articles' });
    }
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
