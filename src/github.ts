import { graphql } from "@octokit/graphql";
import { Octokit } from "@octokit/rest";
import { config } from "./config";
import { GitIssue, Thread } from "./interfaces";
import { store } from "./store";

import { Attachment, Collection, Message } from "discord.js";
import {
  ActionValue,
  Actions,
  Triggerer,
  getGithubUrl,
  logger,
} from "./logger";

const octokit = new Octokit({
  auth: config.GITHUB_ACCESS_TOKEN,
  baseUrl: "https://api.github.com",
});

const graphqlWithAuth = graphql.defaults({
  headers: {
    authorization: `token  ${process.env.GITHUB_ACCESS_TOKEN}`,
  },
});

const repoCredentials = {
  owner: config.GITHUB_USERNAME,
  repo: config.GITHUB_REPOSITORY,
};

const info = (action: ActionValue, thread: Thread) =>
  logger.info(`${Triggerer.Discord} | ${action} | ${getGithubUrl(thread)}`);

function update(issue_number: number, state: "open" | "closed") {
  octokit.rest.issues.update({
    ...repoCredentials,
    issue_number,
    state,
  });
}

function attachmentsToMarkdown(attachments: Collection<string, Attachment>) {
  let md = "";
  attachments.forEach(({ url, name, contentType }) => {
    switch (contentType) {
      case "image/png":
      case "image/jpeg":
        md += `![${name}](${url} "${name}")`;
        break;
    }
  });
  return md;
}

function getIssueBody(params: Message) {
  const { guildId, channelId, content, author, attachments } = params;
  const { username, id } = author;
  const bot = store.client?.user;

  return (
    `${content}\n` +
    `${attachmentsToMarkdown(attachments)}\n` +
    "---\n" +
    `Thread: [#${channelId}](https://discord.com/channels/${guildId}/${channelId})\n` +
    `User: [@${username}](https://discordapp.com/users/${id})\n` +
    `*This message was generated by [@${bot?.tag}](https://discordapp.com/users/${bot?.id})*`
  );
}

function formatIssuesToThreads(issues: GitIssue[]): Thread[] {
  const regex = /Thread: \[#(\d+)\]/;
  const res: Thread[] = [];
  issues.forEach(({ title, body, number, node_id, locked, state }) => {
    const match = body.match(regex);
    if (match) {
      const id = match[1];
      res.push({
        id,
        title,
        number,
        body,
        node_id,
        locked,
        appliedTags: [],
        archived: state === "closed",
      });
    }
  });
  return res;
}

export function closeIssue(thread: Thread) {
  const { number } = thread;
  if (!number) return;

  info(Actions.Closed, thread);

  update(number, "closed");
}

export function openIssue(thread: Thread) {
  const { number } = thread;
  if (!number) return;

  info(Actions.Reopened, thread);

  update(number, "open");
}

export function lockIssue(thread: Thread) {
  const { number } = thread;
  if (!number) return;

  info(Actions.Locked, thread);

  octokit.rest.issues.lock({
    ...repoCredentials,
    issue_number: number,
  });
}

export function unlockIssue(thread: Thread) {
  const { number } = thread;
  if (!number) return;

  info(Actions.Unlocked, thread);

  octokit.rest.issues.unlock({
    ...repoCredentials,
    issue_number: number,
  });
}

export function createIssue(thread: Thread, params: Message) {
  const { title, appliedTags } = thread;
  const labels = appliedTags?.map(
    (id) => store.availableTags.find((item) => item.id === id)?.name || "",
  );

  const body = getIssueBody(params);
  octokit.rest.issues
    .create({
      ...repoCredentials,
      labels,
      title,
      body,
    })
    .then((res) => {
      thread.node_id = res.data.node_id;
      thread.body = res.data.body!;
      thread.number = res.data.number;

      info(Actions.Created, thread);
    });
}

export function createIssueComment(thread: Thread, params: Message) {
  const body = getIssueBody(params);

  octokit.rest.issues
    .createComment({
      ...repoCredentials,
      issue_number: thread.number!,
      body,
    })
    .then(() => {
      info(Actions.Commented, thread);
    });
}

export function deleteIssue(thread: Thread) {
  const { node_id } = thread;
  if (!node_id) return;

  info(Actions.Deleted, thread);

  try {
    graphqlWithAuth(
      `mutation {deleteIssue(input: {issueId: "${node_id}"}) {clientMutationId}}`,
    );
  } catch (error) {
    // error("Error deleting issue:", error);
  }
}

export async function getIssues() {
  const result = await octokit.rest.issues.listForRepo({
    ...repoCredentials,
    state: "all",
  });

  return formatIssuesToThreads(result.data as GitIssue[]);
}
