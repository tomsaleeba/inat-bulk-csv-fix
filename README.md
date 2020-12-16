# What is this?
A [WOW](https://www.wildorchidwatch.org/) user followed the [instructions to
bulk upload records](https://www.wildorchidwatch.org/s/Bulk-uploaddocx.pdf) to
the iNat website. The records uploaded but there were some issues:
1. the 3 required obs fields didn't get values
1. due to the above issue, none of the observations were added to the WOW project

This script is here to fix that.

**It is written as a one-off fix for this specific user's specific problem**.
It could be adapted to help other users, but you'll need to be able to program
to do that. It is **NOT** a production ready tool. Also, it was written
incrementally, so things from early in the process are probably still hanging
around.


## How does it work?
At a high level, it will
1. read all the records from the CSV
1. get all the iNat records that are tagged as coming from the CSV upload
1. try to match each record in the CSV to a remote record on iNat. There is
   logic to try to do it generically but there were edge cases galore so there
   are lots of workarounds including hardcoded matches.
1. once every record is matched, we can start making updates
1. we add the missing observation fields
1. we update the observation to add it to the WOW project. Also, as some of the
   dates were interpreted as US-formatted, we fix those at the same time
1. finally we allow curators of the project to see the obscured coordinates

## Quick start
1. git clone
1. install deps: `yarn`
1. edit the code because **IT WON'T WORK FOR YOU OUT OF THE BOX**: `vim index.js`
1. run it: `JWT=ey... node index.js`
