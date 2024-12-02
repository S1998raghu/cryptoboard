require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { MongoClient } = require("mongodb");
const config = require('./config');
const app = express();

app.use(express.json());
app.use(cors());

const PORT = config.PORT;

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


// Schedule a task to refresh the cache every hour
cron.schedule('0 * * * *', async () => {
    console.log('Refreshing cache...');

    try {
        // Manually refresh the articles data
        const articlesResponse = await axios.get(`http://localhost:${PORT}/articles`);
        cache.set('articles', articlesResponse.data);

        // Manually refresh the trending data
        const trendingResponse = await axios.get(`http://localhost:${PORT}/trending`);
        const trendingTopics = trendingResponse.data; // Get the trending topics from the response
        cache.set('trending', trendingTopics);

        console.log('Cache refreshed successfully.');
    } catch (error) {
        console.error('Error refreshing cache:', error);
    }
});

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

// Helper function to check if an article is new
function isArticleNew(existingArticles, newArticle) {
    return !existingArticles.some(existing => existing.title === newArticle.title);
}

// Function to check if any existing articles have missing fields
function checkMissingFields(existingArticles, fieldsToCheck) {
    return existingArticles.some(article =>
        fieldsToCheck.some(field => !article.hasOwnProperty(field))
    );
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

        // Check if existing articles have missing fields
        const fieldsToCheck = ['publicationDate', 'title', 'url', 'source'];
        const isMissingField = checkMissingFields(existingArticles, fieldsToCheck);

        // If fields are missing, remove all existing documents and insert new ones
        if (isMissingField) {
            await guardianCollection.deleteMany({});
            console.log('Existing Guardian articles had missing fields. Removed all documents.');

            if (newArticles.length) {
                await guardianCollection.insertMany(newArticles);
                console.log(`Successfully inserted ${newArticles.length} Guardian articles into MongoDB.`);
            } else {
                return res.json({ message: 'No articles found from The Guardian API' });
            }
        } else {
            // If no fields are missing, update only new articles
            const newArticlesToInsert = newArticles.filter(article => isArticleNew(existingArticles, article));
            if (newArticlesToInsert.length) {
                await guardianCollection.insertMany(newArticlesToInsert);
                console.log(`Successfully inserted ${newArticlesToInsert.length} new Guardian articles into MongoDB.`);
            } else {
                console.log('No new Guardian articles found to add.');
            }
        }

        // Fetch the updated articles and return them
        const updatedArticles = await guardianCollection.find().toArray();
        res.json(updatedArticles);

    } catch (error) {
        console.error("Error fetching Guardian articles:", error);
        res.status(500).json({ message: 'Error fetching Guardian articles' });
    }
});

/**
 * The New York Times Business API - Fetches and stores articles from NYTimes
 */
app.get('/nytimes', async (req, res) => {
    const API_KEY = 'wCuAbXRh08VZYQ39Bq0ZjcHOhVWtBME3';
    const BASE_URL = 'https://api.nytimes.com/svc/search/v2/articlesearch.json';
    const query = 'crypto';

    try {
        // Fetch existing articles from MongoDB
        const existingArticles = await nytCollection.find().toArray();

        // Fetch articles from NYTimes API
        const url = `${BASE_URL}?q=${query}&api-key=${API_KEY}`;
        const response = await axios.get(url);
        const articles = response.data.response.docs;

        // Map the fetched articles to the required structure
        const newArticles = articles.map(article => ({
            publicationDate: article.pub_date,
            title: article.headline.main,
            url: article.web_url,
            source: extractHostname(article.web_url)
        }));

        // Check if existing articles have missing fields
        const fieldsToCheck = ['publicationDate', 'title', 'url', 'source'];
        const isMissingField = checkMissingFields(existingArticles, fieldsToCheck);

        // If fields are missing, remove all existing documents and insert new ones
        if (isMissingField) {
            await nytCollection.deleteMany({});
            console.log('Existing NYTimes articles had missing fields. Removed all documents.');

            if (newArticles.length) {
                await nytCollection.insertMany(newArticles);
                console.log(`Successfully inserted ${newArticles.length} NYTimes articles into MongoDB.`);
            } else {
                return res.json({ message: 'No articles found from NYTimes API' });
            }
        } else {
            // If no fields are missing, update only new articles
            const newArticlesToInsert = newArticles.filter(article => isArticleNew(existingArticles, article));
            if (newArticlesToInsert.length) {
                await nytCollection.insertMany(newArticlesToInsert);
                console.log(`Successfully inserted ${newArticlesToInsert.length} new NYTimes articles into MongoDB.`);
            } else {
                console.log('No new NYTimes articles found to add.');
            }
        }

        // Fetch the updated articles and return them
        const updatedArticles = await nytCollection.find().toArray();
        res.json(updatedArticles);

    } catch (error) {
        console.error("Error fetching NYTimes articles:", error);
        res.status(500).json({ message: 'Error fetching NYTimes articles' });
    }
});

/**
 * The Reddit Business API - Fetches and stores posts from Reddit
 */
app.get('/reddit', async (req, res) => {
    const BASE_URL = 'https://oauth.reddit.com/search';
    const query = 'crypto';

    try {
        // Get Reddit access token
        const accessToken = await getRedditAccessToken();

        // Step 1: Fetch existing articles from MongoDB
        const existingArticles = await redditCollection.find().toArray();

        // Step 2: Fetch posts from Reddit API
        const url = `${BASE_URL}?q=${query}`;
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'ChangeMeClient/0.1 by YourUsername',
                'Authorization': `bearer ${accessToken}`
            }
        });
        const posts = response.data.data.children;
        const totalResults = response.data.data.dist; // Get the total number of results

        // Step 3: Map the fetched posts to the required structure and include the "link" field using "permalink"
        const newPosts = posts.map(post => ({
            reddit: post.data.subreddit_name_prefixed || "",
            author: post.data.author_fullname || "",
            title: post.data.title || "",
            description: post.data.selftext || "",
            image: post.data.preview?.images?.[0]?.source?.url || "",
            link: `https://www.reddit.com${post.data.permalink}`, // Include permalink as the link field
            source: extractHostname(post.data.url)
        }));

        // Step 4: Check if existing articles have missing fields
        const fieldsToCheck = ['reddit', 'author', 'title', 'description', 'image', 'link', 'source'];
        const isMissingField = existingArticles.some(article =>
            fieldsToCheck.some(field => !article.hasOwnProperty(field))
        );

        // Step 5: If fields are missing, remove all existing documents and insert the new ones
        if (isMissingField) {
            await redditCollection.deleteMany({});
            console.log('Existing Reddit articles had missing fields. Removed all documents.');

            if (newPosts.length) {
                await redditCollection.insertMany(newPosts);
                console.log(`Successfully inserted ${newPosts.length} Reddit articles into MongoDB.`);
            } else {
                console.log('No new Reddit articles found.');
                return res.json({ message: 'No new articles to update from Reddit API' });
            }
        } else {
            // Step 6: If no fields are missing, update only new posts
            const newPostsToInsert = newPosts.filter(post => isArticleNew(existingArticles, post));
            if (newPostsToInsert.length) {
                await redditCollection.insertMany(newPostsToInsert);
                console.log(`Successfully inserted ${newPostsToInsert.length} new Reddit articles into MongoDB.`);
            } else {
                console.log('No new Reddit articles found to add.');
            }
        }

        // Step 7: Fetch the updated posts and return them along with totalResults
        const updatedPosts = await redditCollection.find().toArray();
        res.json({ totalResults, articles: updatedPosts });

    } catch (error) {
        console.error("Error fetching Reddit articles:", error);
        res.status(500).json({ message: 'Error fetching Reddit articles' });
    }
});

// New endpoint to combine articles from The Guardian, NYTimes, and Reddit
app.get('/articles', async (req, res) => {
    const cachedArticles = cache.get('articles');
    if (cachedArticles) {
        return res.json(cachedArticles);
    }
    try {
        const guardianArticles = await guardianCollection.find().toArray();
        const nytArticles = await nytCollection.find().toArray();
        const redditArticles = await redditCollection.find().toArray();

        // Function to map articles to the unified format with sentiment analysis
        function mapToUnifiedFormat(article, source) {
            const sentimentScore = analyzeSentiment(article.title + ' ' + (article.description || ""));
            return {
                id: article._id,
                title: article.title,
                source: source,
                publicationDate: article.publicationDate,
                url: article.url,
                description: article.description || "",
                author: article.author || "",
                image: article.image || "",
                reddit: article.reddit || "",
                link: article.link || "",
                sentiment: sentimentScore // Add sentiment score to the response
            };
        }

        const unifiedGuardianArticles = guardianArticles.map(article => mapToUnifiedFormat(article, 'guardian'));
        const unifiedNytArticles = nytArticles.map(article => mapToUnifiedFormat(article, 'nytimes'));
        const unifiedRedditArticles = redditArticles.map(article => mapToUnifiedFormat(article, 'reddit'));

        const allCombinedArticles = [
            ...unifiedGuardianArticles,
            ...unifiedNytArticles,
            ...unifiedRedditArticles
        ];

        // Cache the result before sending the response
        cache.set('articles', allCombinedArticles);
        res.json(allCombinedArticles);
    } catch (error) {
        console.error("Error fetching combined articles:", error);
        res.status(500).json({ message: 'Error fetching combined articles' });
    }
});

app.get('/trending', async (req, res) => {
    const cachedTrending = cache.get('trending');
    if (cachedTrending) {
        return res.json(cachedTrending);
    }
    try {
        const guardianArticles = await guardianCollection.find().toArray();
        const nytArticles = await nytCollection.find().toArray();
        const redditArticles = await redditCollection.find().toArray();

        const allArticles = [...guardianArticles, ...nytArticles, ...redditArticles];
        const keywordCounts = {};

        // Extract keywords and count occurrences
        allArticles.forEach(article => {
            const keywords = extractKeywords(article.title + ' ' + (article.description || ""));
            keywords.forEach(keyword => {
                keywordCounts[keyword] = (keywordCounts[keyword] || 0) + 1;
            });
        });

        // Sort keywords by frequency
        const trendingTopics = Object.entries(keywordCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 20) // Get top 20 trending topics
            .map(([keyword, count]) => ({ keyword, count }));

        // Cache the result before sending the response
        cache.set('trending', trendingTopics);
        res.json(trendingTopics);
    } catch (error) {
        console.error("Error fetching trending topics:", error);
        res.status(500).json({ message: 'Error fetching trending topics' });
    }
});

// New endpoint to get cryptocurrency growth data
app.get('/crypto-growth', async (req, res) => {
    try {
        const { id = 'bitcoin', days = '365', interval = 'daily' } = req.query;

        // Fetch historical market data for the specified cryptocurrency
        const response = await CoinGeckoClient.coins.fetchMarketChart(id, {
            days: days,
            interval: interval,
        });

        if (response.success) {
            const prices = response.data.prices; // Array of [timestamp, price]
            const growthData = prices.map(priceData => ({
                date: new Date(priceData[0]).toISOString(),
                price: priceData[1],
            }));
            res.json(growthData);
        } else {
            res.status(500).json({ message: 'Error fetching data from CoinGecko' });
        }
    } catch (error) {
        console.error('Error fetching cryptocurrency growth data:', error);
        res.status(500).json({ message: 'Error fetching cryptocurrency growth data' });
    }
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});