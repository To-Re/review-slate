#import <AppKit/AppKit.h>
#include <fcntl.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>

// ReviewSlate's own short-lived chooser. It never talks to or automates another app.
static void output(NSDictionary *result) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:result options:0 error:nil];
    if (data) { fwrite(data.bytes, 1, data.length, stdout); fputc('\n', stdout); fflush(stdout); }
}

@interface PickerDelegate : NSObject <NSApplicationDelegate>
@property NSOpenPanel *panel;
@property NSString *locale;
@property NSString *initialDirectory;
@property NSTimeInterval timeout;
@property pid_t parentPID;
@property BOOL completed;
@end

@implementation PickerDelegate
- (void)finish:(NSDictionary *)result {
    if (self.completed) return;
    self.completed = YES;
    [self.panel orderOut:nil];
    output(result);
    [NSApp terminate:nil];
}
- (void)cancelSelection:(id)sender {
    [self finish:@{@"version": @1, @"status": @"cancelled"}];
}
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    BOOL chinese = [self.locale isEqualToString:@"zh-CN"];
    NSMenu *menu = [NSMenu new];
    NSMenuItem *appItem = [NSMenuItem new]; [menu addItem:appItem];
    NSMenu *appMenu = [NSMenu new];
    NSMenuItem *quit = [[NSMenuItem alloc] initWithTitle:chinese ? @"取消选择" : @"Cancel selection" action:@selector(cancelSelection:) keyEquivalent:@"q"];
    quit.target = self; [appMenu addItem:quit]; appItem.submenu = appMenu; NSApp.mainMenu = menu;
    self.panel = [NSOpenPanel openPanel];
    self.panel.title = chinese ? @"ReviewSlate · 选择项目文件夹" : @"ReviewSlate · Choose project folder";
    self.panel.message = chinese ? @"选择 Git 仓库或其中的子文件夹。选择后将校验仓库。" : @"Choose a Git repository or a folder inside it. The repository will be validated after selection.";
    self.panel.prompt = chinese ? @"选择文件夹" : @"Choose folder";
    self.panel.canChooseDirectories = YES; self.panel.canChooseFiles = NO;
    self.panel.allowsMultipleSelection = NO; self.panel.canCreateDirectories = NO;
    self.panel.resolvesAliases = YES; self.panel.treatsFilePackagesAsDirectories = NO;
    self.panel.canDownloadUbiquitousContents = NO; self.panel.canResolveUbiquitousConflicts = NO;
    if (self.initialDirectory) self.panel.directoryURL = [NSURL fileURLWithPath:self.initialDirectory isDirectory:YES];
    [self.panel beginWithCompletionHandler:^(NSModalResponse response) {
        NSURL *url = self.panel.URL;
        if (response == NSModalResponseOK && url.isFileURL) {
            [self finish:@{@"version": @1, @"status": @"selected", @"path": url.path}];
        } else [self finish:@{@"version": @1, @"status": @"cancelled"}];
    }];
    if (@available(macOS 14.0, *)) [NSApp activate];
    else [NSApp activateIgnoringOtherApps:YES];
    [self.panel makeKeyAndOrderFront:nil];
    [NSTimer scheduledTimerWithTimeInterval:self.timeout repeats:NO block:^(NSTimer *timer) {
        [self finish:@{@"version": @1, @"status": @"timed-out"}];
    }];
    [NSTimer scheduledTimerWithTimeInterval:1 repeats:YES block:^(NSTimer *timer) {
        if (getppid() != self.parentPID) [self finish:@{@"version": @1, @"status": @"cancelled"}];
    }];
}
// AppKit's Go to Folder sheet can be the last locally tracked window while the open panel
// is displayed by the system service. Closing that sheet must not terminate this request.
// Only the panel completion, explicit cancellation, timeout, or parent exit finishes it.
- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender { return NO; }
@end

int main(int argc, const char *argv[]) {
    const pid_t parentPID = getppid();
    @autoreleasepool {
        NSString *locale = @"en", *directory = nil;
        double timeout = 120;
        for (int i = 1; i < argc; i += 2) {
            if (i + 1 >= argc) return 2;
            NSString *key = @(argv[i]), *value = @(argv[i + 1]);
            if ([key isEqualToString:@"--locale"] && ([value isEqualToString:@"en"] || [value isEqualToString:@"zh-CN"])) locale = value;
            else if ([key isEqualToString:@"--directory"] && value.isAbsolutePath) directory = value;
            else if ([key isEqualToString:@"--timeout-seconds"] && value.doubleValue >= 1 && value.doubleValue <= 300) timeout = value.doubleValue;
            else return 2;
        }
        // A per-user advisory lock also prevents separate stdio processes from opening many panels.
        NSString *lockPath = [NSTemporaryDirectory() stringByAppendingPathComponent:@"org.reviewslate.folderpicker.lock"];
        int lockFD = open(lockPath.fileSystemRepresentation, O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0600);
        struct stat lockStat;
        if (lockFD < 0 || fstat(lockFD, &lockStat) != 0 || !S_ISREG(lockStat.st_mode) || lockStat.st_uid != getuid() || lockStat.st_nlink != 1) {
            if (lockFD >= 0) close(lockFD);
            output(@{@"version": @1, @"status": @"failed", @"reason": @"invalid-lock"}); return 0;
        }
        if (flock(lockFD, LOCK_EX | LOCK_NB) != 0) {
            close(lockFD); output(@{@"version": @1, @"status": @"failed", @"reason": @"busy"}); return 0;
        }
        NSApplication *app = [NSApplication sharedApplication];
        [app setActivationPolicy:NSApplicationActivationPolicyRegular];
        PickerDelegate *delegate = [PickerDelegate new];
        delegate.locale = locale; delegate.initialDirectory = directory;
        delegate.timeout = timeout; delegate.parentPID = parentPID;
        app.delegate = delegate;
        [app run];
        close(lockFD);
    }
    return 0;
}
