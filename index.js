import express from "express";
import cors from "cors";
import "dotenv/config";

import { MongoClient } from "mongodb";

const app = express();
const port = process.env.PORT || 8000;

app.use(express.json());
app.use(cors());

export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.dir(err);
  }
}

const connectedClient = await connectToMongoDB();
console.log(connectedClient);

const db = connectedClient.db("fixmatedb");

app.get("/", (req, res) => {
  res.send("Hello World!");
});

app.listen(port, () => {
  console.log(`Limons app listening on port ${port}`);
});

export default app;
