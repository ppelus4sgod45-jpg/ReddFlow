# ReddFlow

ReddFlow is a personal, non-commercial Reddit media viewer designed to provide a vertical media browsing experience for public subreddit content.

## Purpose

The goal of ReddFlow is to make browsing public Reddit media more convenient by allowing users to:

- Select one or more subreddits
- Browse videos, GIFs and images in a vertical feed
- Filter content by media type
- Save groups of subreddits
- Remember previously viewed media locally
- Avoid showing duplicate media across different subreddit posts
- Play supported external media such as Redgifs

ReddFlow is intended for personal use and does not provide posting, voting, commenting, messaging or moderation functionality.

## Reddit API usage

ReddFlow is being developed to use Reddit's Data API for read-only access to public subreddit listings.

The application only needs access to public listing endpoints such as:

- Hot
- New
- Top

Pagination will use Reddit's standard listing pagination mechanism.

The application may read public post metadata such as:

- Post ID
- Subreddit
- Title
- Author
- Permalink
- Post URL
- Media metadata
- Listing pagination information

ReddFlow does not:

- Create posts
- Submit comments
- Vote
- Send messages
- Moderate communities
- Follow users
- Access private Reddit data
- Automate interactions on behalf of users

## Local data

User preferences are stored locally on the user's device.

This may include:

- Viewed media history
- Saved subreddit groups
- Media filters
- Volume preferences
- Duplicate-media identifiers

This local data is not submitted back to Reddit.

## Media

ReddFlow may display media hosted by Reddit or external media providers referenced by Reddit posts.

For example, Redgifs media may be displayed using URLs or playback methods provided by Redgifs.

ReddFlow also attempts to detect duplicate media so that the same media file is not repeatedly displayed when it has been reposted across different subreddits.

## Why ReddFlow is not a Devvit application

ReddFlow is designed as a standalone browser-based media viewer.

Its functionality requires an interface outside Reddit's native post and community experience, including:

- Continuous vertical media navigation
- Aggregating multiple user-selected subreddits
- Persistent local viewing history
- Local media filters
- Cross-subreddit duplicate-media detection
- External media playback
- User-defined groups of subreddits

Because the main product is a standalone client-side browsing interface, its core use case is not suitable for implementation entirely within the Devvit ecosystem.

## Authentication

Future Reddit Data API access will use OAuth 2.0.

API credentials, tokens and secrets are not included in this repository.

Sensitive configuration files should remain local and must never be committed to the repository.

## Privacy

ReddFlow is intended for personal use.

It does not intentionally collect or sell user data.

It does not require users to provide personal information beyond what may be necessary for future Reddit OAuth authentication.

## Rate limits

ReddFlow will respect Reddit API rate limits and applicable Reddit developer policies.

Requests will be cached or reused where appropriate to reduce unnecessary API traffic.

## Status

ReddFlow is currently under development.

The current version may use public Reddit RSS feeds while official Reddit Data API access is being requested.

The long-term goal is to replace RSS-based loading with official OAuth-authenticated Reddit Data API listings.

## License

Personal / non-commercial project.

No affiliation with Reddit Inc. or Redgifs.

Reddit and associated trademarks belong to their respective owners.
