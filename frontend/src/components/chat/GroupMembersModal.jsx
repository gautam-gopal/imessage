import { useState } from "react";
import { Avatar, Button, Modal, useOverlayState } from "@heroui/react";
import { UsersIcon } from "lucide-react";
import { getInitials } from "../../hooks/useSelectedConversation";
import { useAuthStore } from "../../store/useAuthStore";
import { useChatStore } from "../../store/useChatStore";

function MemberAvatar({ name, avatarUrl }) {
  return (
    <Avatar className="size-9 shrink-0">
      <Avatar.Image alt={name} src={avatarUrl} />
      <Avatar.Fallback className="text-sm font-medium">
        {getInitials(name)}
      </Avatar.Fallback>
    </Avatar>
  );
}

// Reads the group from the store's conversation list, so the member list
// and admin status always reflect the last server sync (every add / remove
// / leave action in the store refreshes that list).
export function GroupMembersModal({ conversationId }) {
  const modal = useOverlayState();

  const conversation = useChatStore((state) =>
    state.conversations.find(
      (item) => item.id === conversationId && item.type === "group",
    ),
  );
  const users = useChatStore((state) => state.users);
  const addGroupMember = useChatStore((state) => state.addGroupMember);
  const removeGroupMember = useChatStore((state) => state.removeGroupMember);
  const authUser = useAuthStore((state) => state.authUser);

  const [busyId, setBusyId] = useState(null);

  if (!conversation) return null;

  const myId = String(authUser?._id);
  const isAdmin = conversation.admins.includes(myId);

  // `users` excludes the logged-in user, so add them back for display.
  const knownUsers = new Map(users.map((user) => [String(user._id), user]));
  if (authUser) knownUsers.set(myId, authUser);

  // System participants (the AI) are listed last and cannot be removed here:
  // any member's next @mention would add the assistant back.
  const members = conversation.participantIds
    .map((id) => ({ id, user: knownUsers.get(id) }))
    .sort(
      (a, b) =>
        Number(Boolean(a.user?.isSystemUser)) -
        Number(Boolean(b.user?.isSystemUser)),
    );
  const humanMemberCount = members.filter(
    ({ user }) => !user?.isSystemUser,
  ).length;

  const addCandidates = users.filter(
    (user) =>
      !user.isSystemUser && !conversation.participantIds.includes(user._id),
  );

  const runAction = async (id, action) => {
    setBusyId(id);
    const didSucceed = await action();
    setBusyId(null);
    return didSucceed;
  };

  const handleRemove = (memberId) =>
    runAction(memberId, () => removeGroupMember(conversation.id, memberId));

  const handleLeave = async () => {
    const didLeave = await handleRemove(myId);
    if (didLeave) modal.close();
  };

  const handleAdd = (userId) =>
    runAction(userId, () => addGroupMember(conversation.id, userId));

  return (
    <Modal.Root state={modal}>
      <Modal.Trigger>
        <Button
          variant="ghost"
          size="sm"
          isIconOnly
          className="shrink-0"
          aria-label="Group members"
        >
          <UsersIcon className="size-5.5" strokeWidth={2} aria-hidden />
        </Button>
      </Modal.Trigger>

      <Modal.Backdrop variant="opaque">
        <Modal.Container size="md" scroll="inside" placement="center">
          <Modal.Dialog className="max-h-[85dvh] border border-white/10 bg-[#2a2a2c] text-foreground shadow-2xl">
            <Modal.Header className="flex flex-row items-center justify-between gap-3 border-b border-white/10 pb-3">
              <Modal.Heading className="truncate text-lg font-semibold tracking-tight text-white">
                {conversation.name}
              </Modal.Heading>
              <Modal.CloseTrigger />
            </Modal.Header>

            <Modal.Body className="isolate space-y-5 pt-4">
              <div>
                <h3 className="mb-2 text-sm font-medium text-zinc-400">
                  Members ({humanMemberCount})
                </h3>
                <div className="rounded-xl border border-white/10">
                  {members.map(({ id, user }) => {
                    const isAssistant = Boolean(user?.isSystemUser);
                    const isSelf = id === myId;
                    const isMemberAdmin = conversation.admins.includes(id);
                    const name = user?.fullName || "Unknown user";

                    return (
                      <div
                        key={id}
                        className="flex items-center gap-3 border-b border-white/10 px-3 py-2 last:border-b-0"
                      >
                        <MemberAvatar
                          name={name}
                          avatarUrl={user?.profilePic}
                        />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-white">
                            {name}
                            {isSelf ? " (You)" : ""}
                          </p>
                          {isAssistant ? (
                            <p className="text-xs text-accent">AI assistant</p>
                          ) : isMemberAdmin ? (
                            <p className="text-xs text-accent">Admin</p>
                          ) : null}
                        </div>

                        {isAssistant ? null : isSelf ? (
                          <Button
                            size="sm"
                            variant="danger-soft"
                            isDisabled={busyId !== null}
                            onPress={handleLeave}
                          >
                            Leave
                          </Button>
                        ) : isAdmin ? (
                          <Button
                            size="sm"
                            variant="danger-soft"
                            isDisabled={busyId !== null}
                            onPress={() => handleRemove(id)}
                          >
                            Remove
                          </Button>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>

              {isAdmin ? (
                <div>
                  <h3 className="mb-2 text-sm font-medium text-zinc-400">
                    Add people
                  </h3>
                  {addCandidates.length === 0 ? (
                    <p className="py-2 text-sm text-zinc-500">
                      Everyone is already in this group.
                    </p>
                  ) : (
                    <div className="max-h-56 overflow-y-auto rounded-xl border border-white/10">
                      {addCandidates.map((user) => (
                        <div
                          key={user._id}
                          className="flex items-center gap-3 border-b border-white/10 px-3 py-2 last:border-b-0"
                        >
                          <MemberAvatar
                            name={user.fullName}
                            avatarUrl={user.profilePic}
                          />
                          <span className="min-w-0 flex-1 truncate text-sm font-medium text-white">
                            {user.fullName}
                          </span>
                          <Button
                            size="sm"
                            variant="secondary"
                            isDisabled={busyId !== null}
                            onPress={() => handleAdd(user._id)}
                          >
                            Add
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : null}
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal.Root>
  );
}
