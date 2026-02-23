var Post = require('../models/post');
var mongoose = require('mongoose');
var faker = require('faker');

async function seedDB() {
  try {
    if (!process.env.DB_HOST) {
      console.log('DB_HOST not set, skipping seed');
      return;
    }

    await mongoose.connect(process.env.DB_HOST);
    console.log('Connected to database');

    // ✅ Do not wipe DB. Only seed if empty.
    const count = await Post.countDocuments();

    if (count > 0) {
      console.log(`Seed skipped: posts collection already has ${count} records`);
      return;
    }

    let posts = [];
    for (let i = 0; i < 100; i++) {
      posts.push({
        title: faker.random.words(),
        body: faker.lorem.paragraphs(),
      });
    }

    await Post.insertMany(posts);
    console.log('Database seeded with 100 records (first time only)');
  } catch (err) {
    console.error(err);
  } finally {
    try {
      await mongoose.connection.close();
    } catch (e) {}
    console.log('Database connection closed');
  }
}

seedDB();
