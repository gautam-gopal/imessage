import { CheckIcon, CheckCheckIcon } from "lucide-react";
import { withTransform } from "../../lib/imagekit";
import { MessageVideo } from "./MessageVideo";

// Compress + size images for the bubble (q-auto works for images; f-auto picks WebP/AVIF).
const IMAGE_TRANSFORM = "q-auto,w-640,f-auto";

// Single check = sent, not yet read. Double check = read (direct: by the
// peer; group: by every current recipient). Groups also show a summary
// once at least one recipient has read it.
function ReadReceipt({ receipt }) {
  if (receipt.type === "direct") {
    const label = receipt.isRead ? "Read" : "Sent";
    const Icon = receipt.isRead ? CheckCheckIcon : CheckIcon;

    return (
      <span
        title={label}
        className={`inline-flex ${receipt.isRead ? "text-accent-foreground" : ""}`}
      >
        <Icon aria-hidden="true" className="size-3.5" />
        <span className="sr-only">{label}</span>
      </span>
    );
  }

  const { readCount, totalCount } = receipt;
  const allRead = readCount >= totalCount;
  const Icon = allRead ? CheckCheckIcon : CheckIcon;
  const summary = allRead
    ? "Read by all"
    : `Read by ${readCount} of ${totalCount}`;

  return (
    <span
      title={readCount > 0 ? summary : "Sent"}
      className={`inline-flex items-center gap-1 ${
        readCount > 0 ? "text-accent-foreground" : ""
      }`}
    >
      <Icon aria-hidden="true" className="size-3.5" />
      {readCount > 0 ? (
        <span>{summary}</span>
      ) : (
        <span className="sr-only">Sent</span>
      )}
    </span>
  );
}

export function MessageBubble({ message }) {
  const isOwnMessage = message.role === "me";
  const hasImage = Boolean(message.imageUrl);
  const hasVideo = Boolean(message.videoUrl);

  return (
    <div
      className={`flex w-full ${isOwnMessage ? "justify-end" : "justify-start"}`}
    >
      <div
        className={`max-w-[min(90%,28rem)] rounded-2xl px-3 py-2 text-[15px] leading-snug sm:max-w-[min(75%,28rem)] sm:px-3.5 ${
          isOwnMessage
            ? "rounded-br-md bg-accent text-accent-foreground"
            : "rounded-bl-md bg-surface"
        }`}
      >
        {hasImage ? (
          <img
            src={withTransform(message.imageUrl, IMAGE_TRANSFORM)}
            alt=""
            className="mb-1.5 max-h-40 max-w-full rounded-lg object-cover sm:max-h-52 sm:rounded-xl"
          />
        ) : null}
        {hasVideo ? <MessageVideo src={message.videoUrl} /> : null}
        {message.text ? (
          <p className="whitespace-pre-wrap wrap-break-word">{message.text}</p>
        ) : null}
        <p
          className={`mt-1 text-[11px] tabular-nums ${
            isOwnMessage
              ? "flex items-center justify-end gap-1 text-accent-foreground/75"
              : "text-muted"
          }`}
        >
          {message.time}
          {isOwnMessage && message.receipt ? (
            <ReadReceipt receipt={message.receipt} />
          ) : null}
        </p>
      </div>
    </div>
  );
}
